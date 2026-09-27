import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LessonComponentDefinition } from "@/lesson-components/registry";
import { callStructured } from "@/server/ai/router";
import { AiNotConfiguredError } from "@/server/ai/types";
import type { FamilyScope } from "@/server/db/family-scope";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { safetyPreambleGenericUk } from "@/server/safety/preamble";
import { pedagogyCatalogForPrompt, REVIEW_CRITERION_LABELS_UK } from "./pedagogy";
import { buildLessonBlockSchema, planSchema, reviewSchema, type GeneratedStep, type LessonBlockGenerated, type LessonPlan, type ReviewOutput } from "./schema";

/**
 * The pedagogical pipeline (ADR-022, D-55): `lesson_planning` (Claude Opus
 * 5.5) → `lesson_generation` (same provider, ADR-022 rationale: consistent
 * terminology between plan and script) → `lesson_review` (OpenAI —
 * **required different provider**, US-6.11 КП-1). A "revise" verdict sends
 * the reviewer's notes back into another `lesson_generation` call; after
 * `MAX_REVISIONS` failed reviews the block is saved as `needs_review` and
 * never shown to the child (ADR-022 step 5).
 */

export const LESSON_PLAN_PROMPT_VERSION = "lesson_planning.v1";
export const LESSON_GENERATION_PROMPT_VERSION = "lesson_generation.v2"; // v2: hook/outcome/techniques + plan input (D-55)
export const LESSON_REVIEW_PROMPT_VERSION = "lesson_review.v1";
export const MAX_REVISIONS = 2;
/** Total generate→review passes possible (first pass + up to `MAX_REVISIONS`
 * revisions) — used to show the child an honest "Перевірка X з N" counter
 * (BUG-035) instead of a bare, repeating stage label. */
export const MAX_REVIEW_PASSES = MAX_REVISIONS + 1;

/** ADR-023 §Частина 1.6: the child-facing progress stages, in order. */
export type PipelineStage = "planning" | "generating" | "reviewing" | "revising" | "saving";

/**
 * ADR-023 §Частина 1.2/1.6: optional hooks used only when this pipeline runs
 * from a `library.warm_topic` background job — `jobId` tags every
 * `ai_calls` row this run makes (daily warm-up budget, `ai_calls.job_id`),
 * `onStage` updates `jobs.payload.stage` so the child's progress screen has
 * something better to show than a static "Готуємо урок…" (D-76). Both
 * fields are optional: a run started outside a job (e.g. `nextSessionBlock`,
 * mid-session — out of ADR-023's scope, unchanged) simply omits them.
 *
 * `onStage`'s second argument (BUG-035) is the current generate→review pass
 * number (1-based, out of `MAX_REVIEW_PASSES`), passed on "generating",
 * "revising" and "reviewing" — omitted on "planning"/"saving", which have no
 * pass number.
 */
export interface PipelineHooks {
  jobId?: string;
  onStage?(stage: PipelineStage, reviewPass?: number): Promise<void>;
}

let planPromptCache: { system: string; user: string } | null = null;
function lessonPlanningPrompt(): { system: string; user: string } {
  planPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "lesson_planning.md"), "utf8"));
  return planPromptCache;
}
let genPromptCache: { system: string; user: string } | null = null;
function lessonGenerationPrompt(): { system: string; user: string } {
  genPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "lesson_generation.md"), "utf8"));
  return genPromptCache;
}
let reviewPromptCache: { system: string; user: string } | null = null;
function lessonReviewPrompt(): { system: string; user: string } {
  reviewPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "lesson_review.md"), "utf8"));
  return reviewPromptCache;
}

export interface PipelineFragment {
  materialId: string;
  materialTitle: string;
  /** `materials.kind` (US-2.6 КП-1) — `"textbook"` outranks any other kind on a conflict (BUG-010). */
  materialKind: string;
  page: number | null;
  text: string;
}

/** ADR-029 (US-2.8): one already-indexed textbook problem number on one of the block's fragment pages. */
export interface KnownProblem {
  materialId: string;
  page: number;
  number: string;
}

export interface PipelineInput {
  familyId: string;
  topicId: string;
  subjectName: string;
  grade: number | null;
  topicTitle: string;
  fragments: PipelineFragment[];
  allowedComponents: LessonComponentDefinition<never, never>[];
  /** Titles of blocks already saved for this topic — review checks against repeating the same pattern (US-6.11 КП-1 "різноманітність"). */
  recentTitles: string[];
  /** ADR-029 (US-2.8): known problem numbers on the fragments' pages — the
   * model may cite `sourceRefs[].problemNumber` ONLY from this list; the
   * server double-checks every citation against `material_problems` anyway
   * (`verifyProblemNumbers` below) regardless of what the prompt says. */
  knownProblems: KnownProblem[];
  /** DB access for the post-generation `material_problems` double-check
   * (right after `lesson_generation`, before `lesson_review` — ADR-029 §1). */
  scope: FamilyScope;
}

export interface PipelineCallLog {
  role: string;
  provider: string;
  model: string;
  costUsd: number;
}

export interface PipelineReviewRecord {
  iteration: number;
  provider: string;
  model: string;
  verdict: ReviewOutput["verdict"];
  scores: ReviewOutput["scores"];
  notes: string[];
  summaryUk: string;
}

export interface PipelineResult {
  /** Only "active" blocks are ever offered to the child (US-6.11 КП-3). */
  status: "active" | "needs_review";
  block: LessonBlockGenerated;
  plan: LessonPlan;
  generationModel: string;
  reviews: PipelineReviewRecord[];
  /** For the library card status text (M-10, US-6.11 КП-3). */
  reviewStatus: "first_pass" | "revised" | "needs_review";
  calls: PipelineCallLog[];
}

/** BUG-010: the textbook is always labeled and listed first — the model is told it outranks any book. */
function fragmentsForPrompt(fragments: PipelineFragment[]): string {
  const sorted = [...fragments].sort((a, b) => (a.materialKind === "textbook" ? -1 : 0) - (b.materialKind === "textbook" ? -1 : 0));
  return sorted
    .map((f) => {
      const label = f.materialKind === "textbook" ? `ПІДРУЧНИК, стор. ${f.page ?? "—"}` : `КНИГА «${f.materialTitle}», стор. ${f.page ?? "—"}`;
      return `[materialId=${f.materialId}, ${label}]\n${f.text}`;
    })
    .join("\n\n");
}

function techniquesForPrompt(plan: LessonPlan): string {
  return plan.techniques.map((t) => `- ${t.key}: ${t.whyUk}`).join("\n");
}

/** ADR-029 (US-2.8): groups known problem numbers by page for the `lesson_generation` prompt (`{{known_problems}}`). */
function knownProblemsForPrompt(knownProblems: KnownProblem[]): string {
  if (knownProblems.length === 0) return "(немає розпізнаних номерів вправ на цих сторінках)";
  const byPage = new Map<string, string[]>();
  for (const p of knownProblems) {
    const key = `${p.materialId}:${p.page}`;
    const list = byPage.get(key) ?? [];
    list.push(p.number);
    byPage.set(key, list);
  }
  return [...byPage.entries()]
    .map(([key, numbers]) => {
      const [materialId, page] = key.split(":");
      return `[materialId=${materialId}, стор. ${page}] № ${numbers.join(", ")}`;
    })
    .join("\n");
}

/**
 * ADR-029 §1 (US-2.8, defense in depth alongside the prompt constraint,
 * NFR-LANG-3): every `sourceRef.problemNumber` the model returned is
 * re-checked against `material_problems` (exact `material_id`+`page`+
 * `number` match) right after `lesson_generation`, before `lesson_review` —
 * a citation with no matching row is silently nulled out (the page itself
 * stays) rather than trusted on the model's word. Never throws: a lookup
 * failure degrades to "drop every citation" rather than blocking the block.
 */
async function verifyProblemNumbers(scope: FamilyScope, block: LessonBlockGenerated): Promise<LessonBlockGenerated> {
  const cited = block.steps.flatMap((s) => s.sourceRefs).filter((r) => r.problemNumber != null);
  if (cited.length === 0) return block;
  const materialIds = [...new Set(cited.map((r) => r.materialId))];
  let rows: { material_id: string; page: number; number: string }[] = [];
  try {
    const { data } = await scope
      .select("material_problems", "material_id, page, number")
      .in("material_id", materialIds)
      .returns<{ material_id: string; page: number; number: string }[]>();
    rows = data ?? [];
  } catch (e) {
    console.warn(`[lesson_generation] material_problems lookup failed, discarding all cited problemNumbers: ${(e as Error).message}`);
  }
  const valid = new Set(rows.map((r) => `${r.material_id}:${r.page}:${r.number.trim().toLowerCase()}`));
  return {
    ...block,
    steps: block.steps.map((s) => ({
      ...s,
      sourceRefs: s.sourceRefs.map((r) => {
        if (r.problemNumber == null) return r;
        const key = `${r.materialId}:${r.page}:${r.problemNumber.trim().toLowerCase()}`;
        if (valid.has(key)) return r;
        console.warn(`[lesson_generation] discarded a problemNumber the model cited with no matching material_problems row: material=${r.materialId} page=${r.page} number=${r.problemNumber}`);
        return { ...r, problemNumber: null };
      }),
    })),
  } as LessonBlockGenerated;
}

function stepSummaryUk(step: GeneratedStep, i: number): string {
  if (step.type === "slide") return `${i + 1}. [slide] ${step.textUk}${step.exampleUk ? ` (приклад: ${step.exampleUk})` : ""}`;
  if (step.type === "choice") return `${i + 1}. [choice] ${step.questionUk} — варіанти: ${step.options.map((o) => o.textUk).join(" / ")}; правильна: ${step.correctOptionId}; пояснення: ${step.explanationUk}`;
  if (step.type === "open") return `${i + 1}. [open] ${step.questionUk} — еталон: ${step.expectedAnswerUk}`;
  return `${i + 1}. [interactive:${step.component}] ${JSON.stringify(step.props).slice(0, 400)}`;
}

function blockForReviewPrompt(block: LessonBlockGenerated): string {
  return [
    `Назва: ${block.titleUk}`,
    `Гачок (перше речення блоку): ${block.hookUk}`,
    `Видимий результат наприкінці: ${block.visibleOutcomeUk}`,
    `Заявлені прийоми: ${block.techniquesUsed.join(", ")}`,
    "Кроки:",
    ...block.steps.map((s, i) => stepSummaryUk(s, i)),
  ].join("\n");
}

async function generateDraft(
  input: PipelineInput,
  plan: LessonPlan,
  revisionNotesUk: string[] | null,
  jobId: string | undefined,
): Promise<{ block: LessonBlockGenerated; call: PipelineCallLog }> {
  const schema = buildLessonBlockSchema(input.allowedComponents);
  const { system, user } = lessonGenerationPrompt();
  const prompt = fillTemplate(user, {
    subject_name: input.subjectName,
    grade: input.grade != null ? String(input.grade) : "—",
    topic_title: input.topicTitle,
    allowed_components: input.allowedComponents.length
      ? input.allowedComponents.map((d) => `- ${d.key}: ${d.promptDoc}`).join("\n")
      : "(немає — не використовуй жодного інтерактивного компонента)",
    fragments: fragmentsForPrompt(input.fragments),
    known_problems: knownProblemsForPrompt(input.knownProblems),
    plan_goal: plan.goalUk,
    plan_hook: plan.hookUk,
    plan_outcome: plan.visibleOutcomeUk,
    plan_techniques: techniquesForPrompt(plan),
    plan_misconceptions: plan.misconceptionsUk.map((m) => `- ${m}`).join("\n"),
    plan_tone: plan.toneNotesUk,
    revision_notes: revisionNotesUk?.length ? revisionNotesUk.map((n) => `- ${n}`).join("\n") : "(це перша спроба — попередніх зауважень немає)",
  });
  const system2 = `${safetyPreambleGenericUk()}\n\n${system}`;
  const res = await callStructured("lesson_generation", { system: system2, prompt, schema }, { familyId: input.familyId, ref: { table: "topics", id: input.topicId }, jobId });
  return { block: res.result, call: { role: "lesson_generation", provider: res.model.provider, model: res.model.model, costUsd: res.costUsd } };
}

async function reviewDraft(
  input: PipelineInput,
  plan: LessonPlan,
  block: LessonBlockGenerated,
  jobId: string | undefined,
): Promise<{ review: ReviewOutput; call: PipelineCallLog }> {
  const { system, user } = lessonReviewPrompt();
  const prompt = fillTemplate(user, {
    subject_name: input.subjectName,
    grade: input.grade != null ? String(input.grade) : "—",
    topic_title: input.topicTitle,
    fragments: fragmentsForPrompt(input.fragments),
    plan_summary: `Мета: ${plan.goalUk}\nПрийоми плану: ${techniquesForPrompt(plan)}\nОчікуваний гачок: ${plan.hookUk}\nОчікуваний результат: ${plan.visibleOutcomeUk}`,
    block_summary: blockForReviewPrompt(block),
    recent_titles: input.recentTitles.length ? input.recentTitles.map((t) => `- ${t}`).join("\n") : "(це перший блок теми)",
    rubric: Object.entries(REVIEW_CRITERION_LABELS_UK).map(([k, v]) => `- ${k}: ${v}`).join("\n"),
  });
  const res = await callStructured("lesson_review", { system, prompt, schema: reviewSchema }, { familyId: input.familyId, ref: { table: "topics", id: input.topicId }, jobId });
  return { review: res.result, call: { role: "lesson_review", provider: res.model.provider, model: res.model.model, costUsd: res.costUsd } };
}

/**
 * BUG-011: the `lesson_review` role has no fallback provider by design
 * (ADR-022 §Модель — the reviewer must stay a different provider than
 * generation), so an unconfigured reviewer (e.g. `OPENAI_API_KEY` unset)
 * surfaces here as `AiNotConfiguredError` with nowhere left to retry.
 * Wrapped in this dedicated, human-readable error so callers (`generate.ts`)
 * can tell "reviewer unavailable" apart from "reviewer ran but never
 * approved" and fall back to the safe simplified template either way,
 * with an accurate reason shown to the parent instead of a generic error.
 */
export class ReviewerUnavailableError extends Error {
  constructor(reason: string) {
    super(`рецензент недоступний: ${translateUnavailableReasonUk(reason)}`);
    this.name = "ReviewerUnavailableError";
  }
}

/** "OPENAI_API_KEY is not set" -> "не налаштовано OPENAI_API_KEY" (falls back to the raw reason otherwise). */
function translateUnavailableReasonUk(reason: string): string {
  const m = /^([A-Z0-9_]+) is not set$/.exec(reason);
  return m ? `не налаштовано ${m[1]}` : reason;
}

/** US-6.11 КП-1: any 0 on `safety` overrides the model's own verdict to `rejected`, defensively. */
function enforcedVerdict(review: ReviewOutput): ReviewOutput {
  if (review.scores.safety === 0 && review.verdict !== "rejected") return { ...review, verdict: "rejected" };
  return review;
}

export async function runPedagogicalPipeline(input: PipelineInput, hooks: PipelineHooks = {}): Promise<PipelineResult> {
  const calls: PipelineCallLog[] = [];
  const jobId = hooks.jobId;

  await hooks.onStage?.("planning");
  const { system: planSys, user: planUser } = lessonPlanningPrompt();
  const planPrompt = fillTemplate(planUser, {
    subject_name: input.subjectName,
    grade: input.grade != null ? String(input.grade) : "—",
    topic_title: input.topicTitle,
    fragments: fragmentsForPrompt(input.fragments),
    techniques_catalog: pedagogyCatalogForPrompt(),
    recent_titles: input.recentTitles.length ? input.recentTitles.map((t) => `- ${t}`).join("\n") : "(це перший блок теми)",
  });
  const planRes = await callStructured("lesson_planning", { system: planSys, prompt: planPrompt, schema: planSchema }, { familyId: input.familyId, ref: { table: "topics", id: input.topicId }, jobId });
  calls.push({ role: "lesson_planning", provider: planRes.model.provider, model: planRes.model.model, costUsd: planRes.costUsd });
  const plan = planRes.result;

  let block: LessonBlockGenerated | null = null;
  let generationModel = "";
  let revisionNotes: string[] | null = null;
  const reviews: PipelineReviewRecord[] = [];
  let status: PipelineResult["status"] = "needs_review";

  for (let iteration = 1; iteration <= MAX_REVISIONS + 1; iteration++) {
    await hooks.onStage?.(iteration === 1 ? "generating" : "revising", iteration);
    const draft = await generateDraft(input, plan, revisionNotes, jobId);
    calls.push(draft.call);
    // ADR-029 §1: the DB double-check runs BEFORE `lesson_review` sees the
    // block, so the reviewer (and the saved block) only ever sees a
    // problemNumber that genuinely exists in `material_problems`.
    block = await verifyProblemNumbers(input.scope, draft.block);
    generationModel = draft.call.model;

    await hooks.onStage?.("reviewing", iteration);
    let reviewed: { review: ReviewOutput; call: PipelineCallLog };
    try {
      reviewed = await reviewDraft(input, plan, block, jobId);
    } catch (e) {
      // BUG-011: no fallback provider exists for `lesson_review` — surface a
      // clear, translated reason instead of leaving `AiNotConfiguredError`
      // (or any other reviewer failure) uncaught mid-pipeline.
      if (e instanceof AiNotConfiguredError) throw new ReviewerUnavailableError(e.message);
      throw e;
    }
    calls.push(reviewed.call);
    const verdict = enforcedVerdict(reviewed.review);
    reviews.push({ iteration, provider: reviewed.call.provider, model: reviewed.call.model, verdict: verdict.verdict, scores: verdict.scores, notes: verdict.notes, summaryUk: verdict.summaryUk });

    if (verdict.verdict === "approved") {
      status = "active";
      break;
    }
    if (iteration > MAX_REVISIONS) {
      status = "needs_review";
      break;
    }
    revisionNotes = verdict.notes.length ? verdict.notes : [verdict.summaryUk];
  }

  const reviewStatus: PipelineResult["reviewStatus"] = status === "needs_review" ? "needs_review" : reviews.length === 1 ? "first_pass" : "revised";
  return { status, block: block!, plan, generationModel, reviews, reviewStatus, calls };
}
