"use server";

import { z } from "zod";
import { requireChild } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { readWorkFullTextFromDrive } from "@/server/drive/workText";

/**
 * S33 (PO decision 2026-09-30, 3rd/final correction): fetches the COMPLETE
 * text of a literary work on demand, right when the child wants to read it
 * — never eagerly, never persisted anywhere but the short in-memory TTL
 * cache inside `drive/workText.ts`. The text itself lives only as a small
 * file on the family's own Google Drive; this action just looks up which
 * file id belongs to this lesson (`literature_lessons.work_full_text_drive_file_id`)
 * and reads it.
 */

const UUID = z.string().uuid();

export type LiteratureWorkFullTextResult = { ok: true; text: string } | { ok: false; reason: string };

export async function getLiteratureWorkFullTextAction(lessonId: string): Promise<LiteratureWorkFullTextResult> {
  const parsed = UUID.safeParse(lessonId);
  if (!parsed.success) return { ok: false, reason: "невірний ідентифікатор уроку" };

  const { ctx } = await requireChild();
  const { data: lesson } = await forFamily(ctx.familyId)
    .select("literature_lessons", "work_full_text_drive_file_id")
    .eq("id", parsed.data)
    .maybeSingle<{ work_full_text_drive_file_id: string | null }>();

  if (!lesson) return { ok: false, reason: "урок не знайдено" };
  if (!lesson.work_full_text_drive_file_id) return { ok: false, reason: "повний текст твору ще не готовий для цього уроку" };

  try {
    const text = await readWorkFullTextFromDrive(ctx.familyId, lesson.work_full_text_drive_file_id);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: `не вдалося завантажити текст з Диска: ${(e as Error).message}` };
  }
}
