"use server";

import { z } from "zod";
import { requireChild } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { narrationTextHash, synthesizeNarration } from "@/server/lessons/narration";
import { searchLiteratureV3, type LiteratureV3SearchResult } from "@/server/lessons/literatureV3Search";
import { createServiceClient } from "@/server/supabase/clients";

/**
 * S45 server actions for the "Українська література" v2.0.0 chapter-package
 * viewer (`LiteratureV3LessonView.tsx`). `submitQuestionAnswerAction` for
 * quiz steps is NOT duplicated here — it already works unchanged for these
 * rows (`app/actions/math-course-v2.ts`, see `literatureV3Persist.ts`'s
 * header for why).
 *
 * The import action lives in a separate file, `app/actions/literature-course-v3.ts`
 * (parent-only — `requireParentAccess`, not `requireChild`), mirroring how
 * `literature-course-v2.ts` is split from this child-facing one.
 */

const UUID = z.string().uuid();
const NARRATABLE_TABLES = new Set(["literature_v3_screens", "literature_v3_reading_items", "literature_v3_biographies"]);

export type NarrateLiteratureV3State = { status: "ok"; audioBase64: string; audioMime: string } | { status: "unavailable" } | { status: "error"; message: string };

/**
 * Generic narration-with-cache for a `literature_v3_*` field whose text the
 * client already has (public content — this only adds TTS audio). Reuses
 * the ALREADY-shared `course_v2_narration_cache` table (ADR-044 §1: its
 * `ref_table`/`ref_id`/`field` key is plain text, not FK-constrained to any
 * specific table) — same pattern as `narrateMathCourseV2Action`
 * (`app/actions/math-course-v2.ts`), just a different, format-scoped action
 * so `NARRATABLE_TABLES` never has to list every format's tables together.
 */
export async function narrateLiteratureV3Action(input: { refTable: string; refId: string; field: string; text: string }): Promise<NarrateLiteratureV3State> {
  const { ctx } = await requireChild();
  if (!NARRATABLE_TABLES.has(input.refTable) || !UUID.safeParse(input.refId).success) return { status: "error", message: "Невірне поле для озвучення." };

  const scope = forFamily(ctx.familyId);
  // Confirm the row belongs to this family before synthesizing/caching anything for it.
  const { data: owns } = await scope.select(input.refTable, "id").eq("id", input.refId).maybeSingle<{ id: string }>();
  if (!owns) return { status: "error", message: "Не знайдено." };

  const hash = narrationTextHash(input.text);
  const service = createServiceClient();
  const { data: cached } = await service
    .from("course_v2_narration_cache")
    .select("audio_base64, audio_mime, text_hash")
    .eq("ref_table", input.refTable)
    .eq("ref_id", input.refId)
    .eq("field", input.field)
    .maybeSingle<{ audio_base64: string; audio_mime: string; text_hash: string }>();
  if (cached && cached.text_hash === hash) return { status: "ok", audioBase64: cached.audio_base64, audioMime: cached.audio_mime };

  const audio = await synthesizeNarration(ctx.familyId, { table: input.refTable, id: input.refId }, input.text);
  if (!audio) return { status: "unavailable" };

  await service
    .from("course_v2_narration_cache")
    .upsert(
      { owner_family_id: ctx.familyId, ref_table: input.refTable, ref_id: input.refId, field: input.field, text_hash: hash, audio_base64: audio.audioBase64, audio_mime: audio.mimeType, cached_at: new Date().toISOString() },
      { onConflict: "ref_table,ref_id,field" },
    )
    .then(
      () => {},
      () => {},
    );

  return { status: "ok", audioBase64: audio.audioBase64, audioMime: audio.mimeType };
}

// ---------------------------------------------------------------------------
// searchLiteratureV3Action — "де пошук по підручнику" (PO feedback
// 2026-10-08, S36). Mirrors `searchLiteratureV2Action`/`searchMathCourseV2Action`
// exactly, plus a search-by-work-TITLE query this format alone supports
// (`literatureV3Search.ts`'s own header).
// ---------------------------------------------------------------------------

export type LiteratureV3SearchState = { status: "ok"; result: LiteratureV3SearchResult } | { status: "error"; message: string };

export async function searchLiteratureV3Action(input: { subjectId: string; page?: string; topicQuery?: string; workQuery?: string }): Promise<LiteratureV3SearchState> {
  const { ctx } = await requireChild();
  const subjectParsed = UUID.safeParse(input.subjectId);
  if (!subjectParsed.success) return { status: "error", message: "Невірний ідентифікатор предмета." };

  const pageTrimmed = input.page?.trim();
  const page = pageTrimmed ? Number.parseInt(pageTrimmed, 10) : undefined;
  if (pageTrimmed && (page == null || Number.isNaN(page))) return { status: "error", message: "Сторінка має бути числом." };

  const topicQuery = input.topicQuery?.trim() || undefined;
  const workQuery = input.workQuery?.trim() || undefined;
  if (!page && !topicQuery && !workQuery) return { status: "error", message: "Вкажи тему, твір або сторінку." };

  const result = await searchLiteratureV3(ctx.familyId, subjectParsed.data, { page, topicQuery, workQuery });
  return { status: "ok", result };
}

// ---------------------------------------------------------------------------
// saveReadingPositionAction / clearReadingPositionAction (US-31.2 КП-2) —
// "повернення до місця" for a `reading` step. See the migration
// (`20261024100000_s45b_literature_v3_reading_position.sql`) for why this is
// its own small table rather than `lesson_sessions.reading_position`
// (ADR-044 §1's original plan) — `literature_v3` creates no orchestrator
// session at all. `offsetCodepoints` is the Unicode CODE POINT offset of
// `content_tts.text` the reader's own scroll position maps to (never a JS
// UTF-16 string index — INTEGRATION.md's explicit requirement), computed
// client-side from scroll ratio.
// ---------------------------------------------------------------------------

export type SaveReadingPositionState = { status: "ok" } | { status: "error"; message: string };

export async function saveReadingPositionAction(input: { lessonId: string; refId: string; offsetCodepoints: number }): Promise<SaveReadingPositionState> {
  const { ctx, profile } = await requireChild();
  if (!UUID.safeParse(input.lessonId).success || !input.refId.trim() || !Number.isFinite(input.offsetCodepoints) || input.offsetCodepoints < 0) {
    return { status: "error", message: "Невірні дані." };
  }

  const scope = forFamily(ctx.familyId);
  const { data: lesson } = await scope.select("literature_v3_lessons", "id").eq("id", input.lessonId).maybeSingle<{ id: string }>();
  if (!lesson) return { status: "error", message: "Урок не знайдено." };

  const service = createServiceClient();
  const { error } = await service
    .from("literature_v3_reading_positions")
    .upsert(
      {
        owner_family_id: ctx.familyId,
        child_profile_id: profile.id,
        lesson_id: input.lessonId,
        position: { kind: "reading", ref_id: input.refId, offset_codepoints: Math.round(input.offsetCodepoints) },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "child_profile_id,lesson_id" },
    );
  if (error) return { status: "error", message: `Не вдалося зберегти позицію читання (${error.message}).` };
  return { status: "ok" };
}

export async function clearReadingPositionAction(input: { lessonId: string }): Promise<SaveReadingPositionState> {
  const { profile } = await requireChild();
  if (!UUID.safeParse(input.lessonId).success) return { status: "error", message: "Невірні дані." };

  const service = createServiceClient();
  const { error } = await service.from("literature_v3_reading_positions").delete().eq("child_profile_id", profile.id).eq("lesson_id", input.lessonId);
  if (error) return { status: "error", message: `Не вдалося очистити позицію читання (${error.message}).` };
  return { status: "ok" };
}
