import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callStructured } from "@/server/ai/router";
import type { FamilyScope } from "@/server/db/family-scope";
import { saveWorkFullTextToDrive } from "@/server/drive/workText";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { safetyPreambleGenericUk } from "@/server/safety/preamble";
import { looksComplete, looksEncodedCorrectly } from "./content-qa";
import { literatureExtractionSchema, type LiteratureTopicOut } from "./literature-schema";

/**
 * S33 (PO decision 2026-09-30, corrected same day): a SEPARATE, PARALLEL
 * path to `runPedagogicalPipeline` (`pipeline.ts`) for subjects whose
 * textbook is already organized into clear paragraphs/topics (literature,
 * history, …). One `literature_extraction` AI call per GROUP of book
 * sections (never split mid-section — `groupSectionsForExtraction`)
 * extracts+lightly adapts every course topic the group contains straight
 * from the already-indexed book text, instead of the multi-pass
 * plan → generate → independent-reviewer → revise loop.
 *
 * Deliberately does NOT call `runPedagogicalPipeline`/`generateOneBlock` or
 * touch `library_items`/`library_steps` — those are unchanged and still
 * used by every other subject. Only the deterministic, $0 `content_qa`
 * gate (reused from `content-qa.ts`) runs after this — no second-pass
 * paid reviewer (this is extraction, not creative generation, per the PO).
 *
 * PO correction 2026-09-30 (3rd/final): the complete text of a literary
 * work is NEVER AI-generated and NEVER stored in our Supabase DB
 * (copyright) — the DB only ever holds short quoted excerpts
 * (`work.excerptsUk`). The complete text — already-recognized text sliced
 * from the same already-indexed `chunks` this whole module reads, never a
 * fresh scan — is instead written as a small text file to the family's OWN
 * Google Drive (the same `drive.file` OAuth grant already used for book
 * uploads, `drive/workText.ts`) and only that file's id is kept in the DB
 * (`literature_lessons.work_full_text_drive_file_id`). The child reads it
 * on demand, fetched through a short in-memory TTL cache — never persisted
 * anywhere else.
 */

export const LITERATURE_EXTRACTION_PROMPT_VERSION = "literature_extraction.v1";

/**
 * Conservative per-call character budget for the concatenated book text
 * handed to one `literature_extraction` call. Claude Opus 5.5's context
 * window comfortably holds far more than this, but a large budget also
 * means a large, slow, expensive single call and a bigger blast radius if
 * one call needs a retry — this errs conservative and splits a big book
 * into a handful of section-groups rather than one giant call. Documented
 * assumption, not a hard platform limit — tune if real books need it.
 */
export const MAX_GROUP_CHARS = 90_000;

export interface MaterialSectionRow {
  id: string;
  title: string;
  page_from: number | null;
  page_to: number | null;
  sort_order: number;
}

export interface ChunkRow {
  page: number | null;
  text: string;
  ordinal: number;
}

export interface SectionGroup {
  sections: MaterialSectionRow[];
  text: string;
}

/** The section whose `[page_from, page_to]` contains `page`, or the last section before it when the page falls in a gap. */
function sectionForPage(sections: MaterialSectionRow[], page: number | null): MaterialSectionRow | null {
  if (page == null || sections.length === 0) return null;
  const contains = sections.find((s) => s.page_from != null && s.page_to != null && page >= s.page_from && page <= s.page_to);
  if (contains) return contains;
  // Fall back to the last section starting at or before this page (covers
  // front-matter-less gaps between two sections' ranges).
  let best: MaterialSectionRow | null = null;
  for (const s of sections) {
    if (s.page_from != null && s.page_from <= page && (best == null || (best.page_from ?? 0) < s.page_from)) best = s;
  }
  return best;
}

/**
 * Groups a material's `material_sections` (in `sort_order`) into
 * `literature_extraction` call batches: sections are accumulated in order
 * and a group is flushed just BEFORE adding the next section would push it
 * past `maxChars` — so a group boundary always falls between two sections,
 * never inside one. A single section that alone exceeds `maxChars` is still
 * sent whole, as its own group (never split mid-section, per the PO's
 * explicit instruction) — the budget is a soft target, not a hard cap.
 * Sections with no page range, or no chunks in range, are skipped (nothing
 * indexed to extract from).
 */
export function groupSectionsForExtraction(sections: MaterialSectionRow[], chunks: ChunkRow[], maxChars = MAX_GROUP_CHARS): SectionGroup[] {
  const ordered = [...sections].sort((a, b) => a.sort_order - b.sort_order);
  const chunksBySection = new Map<string, ChunkRow[]>();
  for (const chunk of [...chunks].sort((a, b) => a.ordinal - b.ordinal)) {
    const section = sectionForPage(ordered, chunk.page);
    if (!section) continue;
    const list = chunksBySection.get(section.id) ?? [];
    list.push(chunk);
    chunksBySection.set(section.id, list);
  }

  const groups: SectionGroup[] = [];
  let current: MaterialSectionRow[] = [];
  let currentText = "";

  const flush = () => {
    if (current.length === 0) return;
    groups.push({ sections: current, text: currentText });
    current = [];
    currentText = "";
  };

  for (const section of ordered) {
    const cks = chunksBySection.get(section.id);
    if (!cks || cks.length === 0) continue; // nothing indexed for this section
    const pageRange = section.page_from != null && section.page_to != null ? `${section.page_from}–${section.page_to}` : "?";
    const header = `\n\n## ${section.title} (стор. ${pageRange})\n\n`;
    const body = cks.map((c) => `[стор. ${c.page ?? "?"}] ${c.text}`).join("\n\n");
    const addition = header + body;

    if (current.length > 0 && currentText.length + addition.length > maxChars) flush();
    current.push(section);
    currentText += addition;
  }
  flush();
  return groups;
}

let promptCache: { system: string; user: string } | null = null;
function literatureExtractionPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "literature_extraction.md"), "utf8"));
  return promptCache;
}

export interface LiteratureExtractionInput {
  familyId: string;
  subjectId: string;
  materialId: string;
  materialTitle: string;
  subjectName: string;
  grade: number | null;
}

export interface LiteratureContentQaFailure {
  field: string;
  reason: string;
}
export interface LiteratureContentQaResult {
  ok: boolean;
  failures: LiteratureContentQaFailure[];
}

/**
 * Deterministic, $0 QA gate (ADR-034's `looksComplete`/`looksEncodedCorrectly`,
 * reused as-is — no new heuristics): every prose field of one extracted
 * topic must look complete (not truncated mid-sentence) and correctly
 * encoded. No verbatim-fidelity check here (unlike `content-qa.ts`'s
 * fallback-excerpt path) — this role's whole job is paraphrase/adaptation,
 * so nothing here is expected to be a literal substring of the source text
 * except the textbook questions themselves, which are numbering-checked
 * separately (`verifyQuestionNumbering`).
 */
export function checkLiteratureTopicContentQa(topic: LiteratureTopicOut): LiteratureContentQaResult {
  const failures: LiteratureContentQaFailure[] = [];
  const check = (field: string, text: string, kind: "prose" | "label" = "prose") => {
    if (!looksComplete(text, kind)) failures.push({ field, reason: "текст виглядає обірваним (закінчується на середині речення/слова/числа)" });
    const enc = looksEncodedCorrectly(text);
    if (!enc.ok) failures.push({ field, reason: enc.reason! });
  };

  check("goalUk", topic.goalUk);
  check("explanationMdUk", topic.explanationMdUk);
  topic.keyConceptsUk.forEach((c, i) => check(`keyConceptsUk[${i}]`, c, "label"));
  if (topic.work) {
    check("work.excerptsUk", topic.work.excerptsUk);
    check("work.summaryUk", topic.work.summaryUk);
    if (topic.work.authorBioUk) check("work.authorBioUk", topic.work.authorBioUk);
    if (topic.work.otherWorksUk) check("work.otherWorksUk", topic.work.otherWorksUk);
  }
  topic.sublessons.forEach((sl, i) => {
    sl.questionGroups.forEach((g, j) => {
      g.items.forEach((it, k) => check(`sublessons[${i}].questionGroups[${j}].items[${k}].textUk`, it.textUk, "prose"));
    });
  });
  topic.test.questions.forEach((q, i) => {
    check(`test.questions[${i}].questionUk`, q.questionUk);
    check(`test.questions[${i}].explanationUk`, q.explanationUk);
  });

  return { ok: failures.length === 0, failures };
}

function groupTextForPrompt(group: SectionGroup): string {
  return group.text;
}

export interface ExtractionCallLog {
  role: "literature_extraction";
  provider: string;
  model: string;
  costUsd: number;
}

/** Runs the `literature_extraction` AI call for one section-group and validates the result deterministically. */
export async function extractTopicsForGroup(
  input: LiteratureExtractionInput,
  group: SectionGroup,
): Promise<{ topics: LiteratureTopicOut[]; call: ExtractionCallLog }> {
  const { system, user } = literatureExtractionPrompt();
  const prompt = fillTemplate(user, {
    subject_name: input.subjectName,
    grade: input.grade != null ? String(input.grade) : "—",
    material_title: input.materialTitle,
    book_text: groupTextForPrompt(group),
  });
  const system2 = `${safetyPreambleGenericUk()}\n\n${system}`;
  const res = await callStructured(
    "literature_extraction",
    { system: system2, prompt, schema: literatureExtractionSchema },
    { familyId: input.familyId, ref: { table: "materials", id: input.materialId } },
  );
  return {
    topics: res.result.topics,
    call: { role: "literature_extraction", provider: res.model.provider, model: res.model.model, costUsd: res.costUsd },
  };
}

export interface SavedTopicResult {
  topicNo: number;
  status: "active" | "needs_review";
  failures: LiteratureContentQaFailure[];
  lessonId: string;
}

/**
 * Persists one extracted topic: reuses (or creates) the matching
 * `public.topics` row — ADR-018/ADR-021's existing paragraph/topic model,
 * never duplicated — then upserts `literature_lessons` (keyed on
 * `material_id`+`topic_no`, so re-running extraction on the same book
 * updates in place rather than duplicating) and its `literature_lesson_tests`
 * row. `workFullTextDriveFileId` (PO correction 2026-09-30, 3rd/final) is
 * only ever the id of a text file already written to the family's own
 * Drive by the caller (`runLiteratureExtraction`) — this function never
 * touches Drive itself, and the full text is never part of `lessonRow`.
 */
export async function persistLiteratureTopic(
  scope: FamilyScope,
  ctx: { subjectId: string; materialId: string; grade: number | null },
  topic: LiteratureTopicOut,
  sortOrder: number,
  model: string,
  workFullTextDriveFileId: string | null = null,
): Promise<SavedTopicResult> {
  const contentQa = checkLiteratureTopicContentQa(topic);
  const status: "active" | "needs_review" = contentQa.ok ? "active" : "needs_review";

  const { data: existing } = await scope
    .select("literature_lessons", "id, topic_id")
    .eq("material_id", ctx.materialId)
    .eq("topic_no", topic.topicNo)
    .maybeSingle<{ id: string; topic_id: string | null }>();

  let topicId = existing?.topic_id ?? null;
  if (!topicId) {
    const { data: topicRow, error: topicErr } = await scope.client
      .from("topics")
      .insert({
        owner_family_id: scope.familyId,
        subject_id: ctx.subjectId,
        material_id: ctx.materialId,
        title: topic.titleUk,
        page_from: topic.textbookPageFrom,
        page_to: topic.textbookPageTo,
        sort_order: sortOrder,
        grade: ctx.grade,
      })
      .select("id")
      .single<{ id: string }>();
    if (topicErr) throw new Error(`literature topics insert failed: ${topicErr.message}`);
    topicId = topicRow.id;
  }

  const lessonRow = {
    subject_id: ctx.subjectId,
    material_id: ctx.materialId,
    topic_id: topicId,
    topic_no: topic.topicNo,
    section_title: topic.sectionTitleUk ?? null,
    title: topic.titleUk,
    textbook_page_from: topic.textbookPageFrom,
    textbook_page_to: topic.textbookPageTo,
    pdf_page_from: topic.pdfPageFrom,
    pdf_page_to: topic.pdfPageTo,
    goal_uk: topic.goalUk,
    key_concepts: topic.keyConceptsUk,
    explanation_md: topic.explanationMdUk,
    work_title_uk: topic.work?.titleUk ?? null,
    work_excerpts_uk: topic.work?.excerptsUk ?? null,
    work_summary_uk: topic.work?.summaryUk ?? null,
    work_characters_uk: topic.work?.charactersUk ?? null,
    work_idea_uk: topic.work?.ideaUk ?? null,
    work_author_bio_uk: topic.work?.authorBioUk ?? null,
    work_other_works_uk: topic.work?.otherWorksUk ?? null,
    work_full_text_drive_file_id: workFullTextDriveFileId,
    sublessons: topic.sublessons,
    teacher_note_uk: topic.teacherNoteUk ?? "",
    model,
    prompt_version: LITERATURE_EXTRACTION_PROMPT_VERSION,
    content_qa: contentQa,
    status,
    sort_order: sortOrder,
  };

  const { data: saved, error: lessonErr } = await scope.client
    .from("literature_lessons")
    .upsert({ ...lessonRow, owner_family_id: scope.familyId }, { onConflict: "material_id,topic_no" })
    .select("id")
    .single<{ id: string }>();
  if (lessonErr) throw new Error(`literature_lessons upsert failed: ${lessonErr.message}`);

  const { error: testErr } = await scope.client
    .from("literature_lesson_tests")
    .upsert(
      { owner_family_id: scope.familyId, lesson_id: saved.id, questions: topic.test.questions, model },
      { onConflict: "lesson_id" },
    );
  if (testErr) throw new Error(`literature_lesson_tests upsert failed: ${testErr.message}`);

  return { topicNo: topic.topicNo, status, failures: contentQa.failures, lessonId: saved.id };
}

export interface RunLiteratureExtractionResult {
  groups: number;
  topics: SavedTopicResult[];
  calls: ExtractionCallLog[];
  /** Topics whose work full-text Drive write failed (e.g. Drive not connected) — the lesson itself is still saved (see `persistLiteratureTopic`'s doc), just without `work_full_text_drive_file_id`. */
  driveWriteFailures: { topicNo: number; reason: string }[];
}

/** Raw already-indexed text for a topic's own textbook page range, straight from `chunks` — never AI-regenerated, never a fresh scan (PO correction 2026-09-30, 3rd/final). */
function fullTextForPageRange(chunks: ChunkRow[], from: number | null, to: number | null): string {
  if (from == null) return "";
  return chunks
    .filter((c) => c.page != null && c.page >= from && (to == null || c.page <= to))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * End-to-end: loads the material's already-indexed `material_sections` +
 * `chunks` (ADR-008 — no re-OCR, no re-indexing), groups them by book
 * section, runs one `literature_extraction` call per group, writes each
 * topic's literary work's full text (sliced from the same already-indexed
 * `chunks`, over the topic's own page range) to the family's own Drive
 * (`drive/workText.ts` — PO correction 2026-09-30, 3rd/final), and persists
 * every returned topic. A Drive-write failure (e.g. Drive not connected for
 * this family) is caught and reported in `driveWriteFailures` — it never
 * blocks saving the lesson itself, only leaves it without a full-text file
 * to open. Intended to be driven by a one-off admin action/script for now
 * (`scripts/run-literature-extraction.ts`) — S33's scope is "make it work
 * for one subject/book today", not a background job queue integration (a
 * natural follow-up once this path is validated).
 */
export async function runLiteratureExtraction(scope: FamilyScope, input: LiteratureExtractionInput): Promise<RunLiteratureExtractionResult> {
  const [{ data: sections }, { data: chunks }] = await Promise.all([
    scope
      .select("material_sections", "id, title, page_from, page_to, sort_order")
      .eq("material_id", input.materialId)
      .order("sort_order")
      .returns<MaterialSectionRow[]>(),
    scope
      .select("chunks", "page, text, ordinal")
      .eq("material_id", input.materialId)
      .order("ordinal")
      .limit(20000)
      .returns<ChunkRow[]>(),
  ]);
  const allChunks = chunks ?? [];

  const groups = groupSectionsForExtraction(sections ?? [], allChunks);
  const calls: ExtractionCallLog[] = [];
  const topics: SavedTopicResult[] = [];
  const driveWriteFailures: { topicNo: number; reason: string }[] = [];
  let sortOrder = 0;

  for (const group of groups) {
    const { topics: extracted, call } = await extractTopicsForGroup(input, group);
    calls.push(call);
    for (const topic of extracted.sort((a, b) => a.topicNo - b.topicNo)) {
      sortOrder += 1;

      let workFullTextDriveFileId: string | null = null;
      if (topic.work) {
        const fullText = fullTextForPageRange(allChunks, topic.textbookPageFrom, topic.textbookPageTo);
        if (fullText.trim()) {
          try {
            workFullTextDriveFileId = await saveWorkFullTextToDrive(input.familyId, `${input.materialTitle} — Тема ${topic.topicNo}.txt`, fullText);
          } catch (e) {
            driveWriteFailures.push({ topicNo: topic.topicNo, reason: (e as Error).message });
          }
        }
      }

      const saved = await persistLiteratureTopic(
        scope,
        { subjectId: input.subjectId, materialId: input.materialId, grade: input.grade },
        topic,
        sortOrder,
        call.model,
        workFullTextDriveFileId,
      );
      topics.push(saved);
    }
  }

  return { groups: groups.length, topics, calls, driveWriteFailures };
}
