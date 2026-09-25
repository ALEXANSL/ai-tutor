import "server-only";
import { allowedForSubject } from "@/lesson-components";
import { forFamily, type FamilyScope } from "@/server/db/family-scope";
import { notifyParent } from "@/server/notifications";
import { validateComponentRef } from "./component-validator";
import { LESSON_GENERATION_PROMPT_VERSION, runPedagogicalPipeline, type PipelineFragment } from "./pipeline";
import type { GeneratedStep } from "./schema";

/** How many saved, *active* blocks of a topic we try to keep on hand (US-16.6: offer 2–3). */
const CANDIDATE_TARGET = 3;
const MIN_CANDIDATES_BEFORE_GENERATING = 2;
const FRAGMENTS_PER_BLOCK = 12;

export interface LibraryStepView {
  id: string;
  sortOrder: number;
  type: string;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  sourceRefs: { materialId: string; materialTitle: string; page: number | null }[];
}
export interface LibraryItemView {
  id: string;
  title: string;
  estimatedMinutes: number | null;
  /** US-6.13: shown at the block's summary, not a step of its own. */
  visibleOutcomeUk: string | null;
  steps: LibraryStepView[];
}

interface ChunkRow {
  material_id: string;
  page: number | null;
  text: string;
  materials: { title: string | null; name: string; kind: string } | { title: string | null; name: string; kind: string }[] | null;
}

function materialOf(row: ChunkRow["materials"]): { title: string; kind: string } {
  const m = Array.isArray(row) ? row[0] : row;
  return { title: m?.title ?? m?.name ?? "Підручник", kind: m?.kind ?? "other" };
}

/** Normalizes one validated generated step into `library_steps` columns. */
function toStepRow(step: GeneratedStep, sortOrder: number) {
  const sourceRefs = step.sourceRefs;
  if (step.type === "slide") {
    return { sort_order: sortOrder, type: "slide", content: { textUk: step.textUk, exampleUk: step.exampleUk ?? null }, visual: {}, source_refs: sourceRefs };
  }
  if (step.type === "choice") {
    return {
      sort_order: sortOrder,
      type: "choice",
      content: { questionUk: step.questionUk, options: step.options, correctOptionId: step.correctOptionId, explanationUk: step.explanationUk },
      visual: {},
      source_refs: sourceRefs,
    };
  }
  if (step.type === "open") {
    return {
      sort_order: sortOrder,
      type: "open",
      content: { questionUk: step.questionUk, expectedAnswerUk: step.expectedAnswerUk, rubricUk: step.rubricUk },
      visual: {},
      source_refs: sourceRefs,
    };
  }
  // "interactive": validated (or downgraded) before this function is called.
  const validated = validateComponentRef({ component: step.component, v: step.v, props: step.props, fallback_text: step.fallbackTextUk });
  if (!validated.ok) {
    return { sort_order: sortOrder, type: validated.fallback.type, content: validated.fallback.content, visual: {}, source_refs: sourceRefs };
  }
  return {
    sort_order: sortOrder,
    type: "interactive",
    content: {},
    visual: { component: validated.component, v: validated.v, props: validated.props, fallback_text: step.fallbackTextUk },
    source_refs: sourceRefs,
  };
}

async function loadCandidates(scope: FamilyScope, topicId: string, limit: number): Promise<{ id: string; title: string; estimated_minutes: number | null }[]> {
  const { data } = await scope
    .select("library_items", "id, title, estimated_minutes")
    .eq("topic_id", topicId)
    .eq("kind", "block")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(limit)
    .returns<{ id: string; title: string; estimated_minutes: number | null }[]>();
  return data ?? [];
}

/**
 * Runs the full pedagogical pipeline (ADR-022: plan → generate → review →
 * revise) for one new block and saves it — `active` (with its "methodical
 * passport", US-6.10) if a review approved it, `needs_review` (hidden from
 * the child, US-6.11 КП-3) if it never passed after `MAX_REVISIONS`.
 */
async function generateOneBlock(
  scope: FamilyScope,
  familyId: string,
  subjectId: string,
  subjectName: string,
  subjectConfig: Record<string, unknown>,
  topicId: string,
  topicTitle: string,
  grade: number | null,
): Promise<string> {
  const { data: chunkRows } = await scope.client
    .from("chunks")
    .select("material_id, page, text, materials(title, name, kind)")
    .eq("owner_family_id", familyId)
    .eq("topic_id", topicId)
    .order("ordinal")
    .limit(FRAGMENTS_PER_BLOCK)
    .returns<ChunkRow[]>();
  if (!chunkRows || chunkRows.length === 0) {
    throw new Error(`no indexed textbook fragments for topic ${topicId} — index the textbook before starting a lesson`);
  }

  const allowedComponents = allowedForSubject((subjectConfig.allowed_components as string[] | undefined) ?? []);
  const fragments: PipelineFragment[] = chunkRows.map((c) => {
    const m = materialOf(c.materials);
    return { materialId: c.material_id, materialTitle: m.title, materialKind: m.kind, page: c.page, text: c.text };
  });
  const { data: recentRows } = await scope
    .select("library_items", "title")
    .eq("topic_id", topicId)
    .eq("kind", "block")
    .order("created_at", { ascending: false })
    .limit(5)
    .returns<{ title: string }[]>();
  const recentTitles = (recentRows ?? []).map((r) => r.title);

  const pipeline = await runPedagogicalPipeline({ familyId, topicId, subjectName, grade, topicTitle, fragments, allowedComponents, recentTitles });
  const block = pipeline.block;

  const pedagogy = {
    goalUk: pipeline.plan.goalUk,
    hookUk: block.hookUk,
    visibleOutcomeUk: block.visibleOutcomeUk,
    techniques: pipeline.plan.techniques.filter((t) => block.techniquesUsed.includes(t.key)),
    misconceptionsUk: pipeline.plan.misconceptionsUk,
    comprehensionChecksUk: pipeline.plan.comprehensionChecksUk,
    reviewStatus: pipeline.reviewStatus,
  };

  const { data: item, error } = await scope.client
    .from("library_items")
    .insert({
      owner_family_id: familyId,
      subject_id: subjectId,
      topic_id: topicId,
      kind: "block",
      title: block.titleUk,
      status: pipeline.status,
      model: pipeline.generationModel,
      prompt_version: LESSON_GENERATION_PROMPT_VERSION,
      grade,
      estimated_minutes: block.estimatedMinutes,
      source_refs: dedupeSourceRefs(block.steps.flatMap((s) => s.sourceRefs)),
      pedagogy,
      child_feedback: { interesting: 0, normal: 0, boring: 0 },
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !item) throw new Error(`saving generated lesson block failed: ${error?.message}`);

  const stepRows = block.steps.map((s, i) => ({ owner_family_id: familyId, item_id: item.id, ...toStepRow(s, i) }));
  const { error: stepsErr } = await scope.client.from("library_steps").insert(stepRows);
  if (stepsErr) throw new Error(`saving generated lesson steps failed: ${stepsErr.message}`);

  if (pipeline.reviews.length > 0) {
    const reviewRows = pipeline.reviews.map((r) => ({
      owner_family_id: familyId,
      library_item_id: item.id,
      iteration: r.iteration,
      reviewer_role: "lesson_review",
      provider: r.provider,
      model: r.model,
      verdict: r.verdict,
      scores: r.scores,
      notes: [r.summaryUk, ...r.notes].join("\n"),
    }));
    const { error: revErr } = await scope.client.from("library_item_reviews").insert(reviewRows);
    if (revErr) console.error(`saving lesson block reviews failed: ${revErr.message}`);
  }

  if (pipeline.status === "needs_review") {
    await notifyParent(familyId, {
      type: "lesson_block_needs_review",
      severity: "normal",
      payload: { topicId, topicTitle, libraryItemId: item.id, title: block.titleUk },
    }).catch((e: Error) => console.error(`needs_review notification failed: ${e.message}`));
  }

  return item.id;
}

function dedupeSourceRefs(refs: { materialId: string; materialTitle: string; page: number | null }[]) {
  const seen = new Map<string, { materialId: string; materialTitle: string; page: number | null }>();
  for (const r of refs) seen.set(`${r.materialId}:${r.page}`, r);
  return [...seen.values()];
}

/**
 * Returns 1–3 candidate blocks for a topic (US-16.6 КП-1, US-9.1 КП-2),
 * generating new ones only when the library does not already have enough
 * (US-19.1, US-19.2 КП-2: reuse first, no duplicate generation calls).
 */
export async function getOrGenerateLessonBlocks(
  familyId: string,
  subjectId: string,
  subjectName: string,
  subjectConfig: Record<string, unknown>,
  topicId: string,
  topicTitle: string,
  grade: number | null,
): Promise<{ id: string; title: string; estimatedMinutes: number | null }[]> {
  const scope = forFamily(familyId);
  let candidates = await loadCandidates(scope, topicId, CANDIDATE_TARGET);
  while (candidates.length < MIN_CANDIDATES_BEFORE_GENERATING) {
    const before = candidates.length;
    await generateOneBlock(scope, familyId, subjectId, subjectName, subjectConfig, topicId, topicTitle, grade);
    candidates = await loadCandidates(scope, topicId, CANDIDATE_TARGET);
    if (candidates.length <= before) break; // generation failed silently-safe stop
  }
  return candidates.map((c) => ({ id: c.id, title: c.title, estimatedMinutes: c.estimated_minutes }));
}

/**
 * BUG-009: picks the next block for a session that was **not already used
 * anywhere in that session** (the caller passes the session's full history,
 * not just the block that just finished). If every saved active block of
 * the topic is already used in this session, generates exactly one more
 * (session-scoped exception to the usual `CANDIDATE_TARGET` cap — ADR-014
 * still reuses across *different* sessions as before) instead of silently
 * repeating one; returns `null` only if that generation also fails to
 * produce a fresh, unused block (the caller ends the lesson early rather
 * than repeat a block without saying so).
 */
export async function nextSessionBlock(
  familyId: string,
  subjectId: string,
  subjectName: string,
  subjectConfig: Record<string, unknown>,
  topicId: string,
  topicTitle: string,
  grade: number | null,
  usedLibraryItemIds: string[],
): Promise<{ id: string; title: string; estimatedMinutes: number | null } | null> {
  const scope = forFamily(familyId);
  const used = new Set(usedLibraryItemIds);
  let candidates = await loadCandidates(scope, topicId, CANDIDATE_TARGET);
  let fresh = candidates.find((c) => !used.has(c.id));
  if (fresh) return { id: fresh.id, title: fresh.title, estimatedMinutes: fresh.estimated_minutes };

  const before = candidates.length;
  await generateOneBlock(scope, familyId, subjectId, subjectName, subjectConfig, topicId, topicTitle, grade);
  candidates = await loadCandidates(scope, topicId, Math.max(CANDIDATE_TARGET, before + 1));
  fresh = candidates.find((c) => !used.has(c.id));
  return fresh ? { id: fresh.id, title: fresh.title, estimatedMinutes: fresh.estimated_minutes } : null;
}

export async function loadLibraryItemTitles(familyId: string, ids: string[]): Promise<{ id: string; title: string; estimatedMinutes: number | null }[]> {
  if (ids.length === 0) return [];
  const { data } = await forFamily(familyId)
    .select("library_items", "id, title, estimated_minutes")
    .in("id", ids)
    .returns<{ id: string; title: string; estimated_minutes: number | null }[]>();
  const byId = new Map((data ?? []).map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ id: r.id, title: r.title, estimatedMinutes: r.estimated_minutes }));
}

const FEEDBACK_KINDS = ["interesting", "normal", "boring"] as const;
export type ChildFeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * US-6.13 КП-3 / US-6.10 КП-3: the child's one-tap "цікаво/нормально/нудно"
 * at a block's end, aggregated per library item (M-13) — never affects
 * points, visible to the parent next to the block in the library.
 */
export async function recordChildFeedback(familyId: string, libraryItemId: string, feedback: ChildFeedbackKind): Promise<void> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("library_items", "child_feedback")
    .eq("id", libraryItemId)
    .maybeSingle<{ child_feedback: Partial<Record<ChildFeedbackKind, number>> | null }>();
  const current = data?.child_feedback ?? {};
  const next = Object.fromEntries(FEEDBACK_KINDS.map((k) => [k, (current[k] ?? 0) + (k === feedback ? 1 : 0)]));
  await scope.update("library_items", { child_feedback: next }).eq("id", libraryItemId);
}

/** Loads one library item with its ordered steps for a session block (US-19.2). */
export async function loadLibraryItem(familyId: string, itemId: string): Promise<LibraryItemView | null> {
  const scope = forFamily(familyId);
  const { data: item } = await scope
    .select("library_items", "id, title, estimated_minutes, pedagogy")
    .eq("id", itemId)
    .maybeSingle<{ id: string; title: string; estimated_minutes: number | null; pedagogy: { visibleOutcomeUk?: string } | null }>();
  if (!item) return null;
  const { data: steps } = await scope
    .select("library_steps", "id, sort_order, type, content, visual, source_refs")
    .eq("item_id", itemId)
    .order("sort_order")
    .returns<{ id: string; sort_order: number; type: string; content: Record<string, unknown>; visual: Record<string, unknown>; source_refs: LibraryStepView["sourceRefs"] }[]>();
  return {
    id: item.id,
    title: item.title,
    estimatedMinutes: item.estimated_minutes,
    visibleOutcomeUk: item.pedagogy?.visibleOutcomeUk ?? null,
    steps: (steps ?? []).map((s) => ({ id: s.id, sortOrder: s.sort_order, type: s.type, content: s.content, visual: s.visual, sourceRefs: s.source_refs })),
  };
}
