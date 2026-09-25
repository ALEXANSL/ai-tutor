import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedForSubject } from "@/lesson-components";
import { callStructured } from "@/server/ai/router";
import { forFamily, type FamilyScope } from "@/server/db/family-scope";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { validateComponentRef } from "./component-validator";
import { buildLessonBlockSchema, type GeneratedStep } from "./schema";

export const LESSON_PROMPT_VERSION = "lesson_generation.v1";

/** How many saved blocks of a topic we try to keep on hand (US-16.6: offer 2–3). */
const CANDIDATE_TARGET = 3;
const MIN_CANDIDATES_BEFORE_GENERATING = 2;
const FRAGMENTS_PER_BLOCK = 12;

let promptCache: { system: string; user: string } | null = null;
function lessonPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "lesson_generation.md"), "utf8"));
  return promptCache;
}

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
  steps: LibraryStepView[];
}

interface ChunkRow {
  material_id: string;
  page: number | null;
  text: string;
  materials: { title: string | null; name: string } | { title: string | null; name: string }[] | null;
}

function materialTitleOf(row: ChunkRow["materials"]): string {
  const m = Array.isArray(row) ? row[0] : row;
  return m?.title ?? m?.name ?? "Підручник";
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
    .select("material_id, page, text, materials(title, name)")
    .eq("owner_family_id", familyId)
    .eq("topic_id", topicId)
    .order("ordinal")
    .limit(FRAGMENTS_PER_BLOCK)
    .returns<ChunkRow[]>();
  if (!chunkRows || chunkRows.length === 0) {
    throw new Error(`no indexed textbook fragments for topic ${topicId} — index the textbook before starting a lesson`);
  }

  const allowedComponents = allowedForSubject((subjectConfig.allowed_components as string[] | undefined) ?? []);
  const schema = buildLessonBlockSchema(allowedComponents);
  const { system, user } = lessonPrompt();
  const fragments = chunkRows
    .map((c) => `[materialId=${c.material_id}, стор. ${c.page ?? "—"}, "${materialTitleOf(c.materials)}"]\n${c.text}`)
    .join("\n\n");
  const prompt = fillTemplate(user, {
    subject_name: subjectName,
    grade: grade != null ? String(grade) : "—",
    topic_title: topicTitle,
    allowed_components: allowedComponents.length ? allowedComponents.map((d) => `- ${d.key}: ${d.promptDoc}`).join("\n") : "(немає — не використовуй жодного інтерактивного компонента)",
    fragments,
  });

  const res = await callStructured("lesson_generation", { system, prompt, schema }, { familyId, ref: { table: "topics", id: topicId } });
  const block = res.result;

  const { data: item, error } = await scope.client
    .from("library_items")
    .insert({
      owner_family_id: familyId,
      subject_id: subjectId,
      topic_id: topicId,
      kind: "block",
      title: block.titleUk,
      status: "active",
      model: res.model.model,
      prompt_version: LESSON_PROMPT_VERSION,
      grade,
      estimated_minutes: block.estimatedMinutes,
      source_refs: dedupeSourceRefs(block.steps.flatMap((s) => s.sourceRefs)),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !item) throw new Error(`saving generated lesson block failed: ${error?.message}`);

  const stepRows = block.steps.map((s, i) => ({ owner_family_id: familyId, item_id: item.id, ...toStepRow(s, i) }));
  const { error: stepsErr } = await scope.client.from("library_steps").insert(stepRows);
  if (stepsErr) throw new Error(`saving generated lesson steps failed: ${stepsErr.message}`);

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

export async function loadLibraryItemTitles(familyId: string, ids: string[]): Promise<{ id: string; title: string; estimatedMinutes: number | null }[]> {
  if (ids.length === 0) return [];
  const { data } = await forFamily(familyId)
    .select("library_items", "id, title, estimated_minutes")
    .in("id", ids)
    .returns<{ id: string; title: string; estimated_minutes: number | null }[]>();
  const byId = new Map((data ?? []).map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ id: r.id, title: r.title, estimatedMinutes: r.estimated_minutes }));
}

/** Loads one library item with its ordered steps for a session block (US-19.2). */
export async function loadLibraryItem(familyId: string, itemId: string): Promise<LibraryItemView | null> {
  const scope = forFamily(familyId);
  const { data: item } = await scope
    .select("library_items", "id, title, estimated_minutes")
    .eq("id", itemId)
    .maybeSingle<{ id: string; title: string; estimated_minutes: number | null }>();
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
    steps: (steps ?? []).map((s) => ({ id: s.id, sortOrder: s.sort_order, type: s.type, content: s.content, visual: s.visual, sourceRefs: s.source_refs })),
  };
}
