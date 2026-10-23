"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireChild, requireParentAccess } from "@/server/auth/guards";
import { deleteVideoLesson, getVideoLessonUrlForTopic } from "@/server/lessons/videoLessons";
import { listSubjectTopicOptions, type TopicOption } from "@/server/subjects/queries";
import { uk } from "@/i18n/uk";

const uuidSchema = z.string().uuid();

/** "Завантажити матеріали" video-lesson uploader (S47) — topic dropdown populated after the parent picks a subject. */
export async function listSubjectTopicsForVideoAction(subjectId: string): Promise<TopicOption[]> {
  const { familyId } = await requireParentAccess();
  const parsed = uuidSchema.safeParse(subjectId);
  if (!parsed.success) return [];
  return listSubjectTopicOptions(familyId, parsed.data);
}

export type DeleteVideoLessonState = { status: "ok" } | { status: "error"; message: string };

/** Parent's "Відео-уроки" panel (S47) — removes both the DB row and the stored file. */
export async function deleteVideoLessonAction(id: string): Promise<DeleteVideoLessonState> {
  const { familyId } = await requireParentAccess();
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) return { status: "error", message: uk.common.error };
  try {
    await deleteVideoLesson(familyId, parsed.data);
  } catch {
    return { status: "error", message: uk.common.error };
  }
  revalidatePath("/parent/subjects", "layout");
  return { status: "ok" };
}

/** Child's subject screen (S47) — signs the video's playback URL only when the "🎬 Відео-урок" modal actually opens. */
export async function getVideoLessonUrlAction(topicId: string): Promise<{ status: "ok"; url: string } | { status: "error" }> {
  const { ctx } = await requireChild();
  const parsed = uuidSchema.safeParse(topicId);
  if (!parsed.success) return { status: "error" };
  const url = await getVideoLessonUrlForTopic(ctx.familyId, parsed.data);
  return url ? { status: "ok", url } : { status: "error" };
}
