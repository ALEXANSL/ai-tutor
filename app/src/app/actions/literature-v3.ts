"use server";

import { z } from "zod";
import { requireChild } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { narrationTextHash, synthesizeNarration } from "@/server/lessons/narration";
import { createServiceClient } from "@/server/supabase/clients";

/**
 * S45 server actions for the "Українська література" v2.0.0 chapter-package
 * viewer (`LiteratureV3LessonView.tsx`). `submitQuestionAnswerAction` for
 * quiz steps is NOT duplicated here — it already works unchanged for these
 * rows (`app/actions/math-course-v2.ts`, see `literatureV3Persist.ts`'s
 * header for why).
 *
 * The import action (parent-only, staged-file upload + `LiteratureV3ImportPanel.tsx`)
 * is NOT part of this slice — see the handback report. This file currently
 * holds only the narrate action, which the viewer needs regardless of how
 * content eventually gets imported.
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
