"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireChild, requireParentAccess } from "@/server/auth/guards";
import { deleteVideoLesson, getVideoLessonUrlById, listTopicVideos, type TopicVideoOption } from "@/server/lessons/videoLessons";
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
  revalidatePath("/subject", "layout");
  return { status: "ok" };
}

/** Child's "🎬 Відео-урок" button (S47, every lesson viewer + the subject topic list) — the list of this topic's videos, fetched before any URL is signed (lets the button show a picker when there's more than one). */
export async function listTopicVideosAction(topicId: string): Promise<TopicVideoOption[]> {
  const { ctx } = await requireChild();
  const parsed = uuidSchema.safeParse(topicId);
  if (!parsed.success) return [];
  return listTopicVideos(ctx.familyId, parsed.data);
}

/** Signs one specific video's playback URL only when the child actually opens/picks it in the modal (S47b: a topic can have several). */
export async function getVideoLessonUrlAction(videoId: string): Promise<{ status: "ok"; url: string } | { status: "error" }> {
  const { ctx } = await requireChild();
  const parsed = uuidSchema.safeParse(videoId);
  if (!parsed.success) return { status: "error" };
  try {
    const url = await getVideoLessonUrlById(ctx.familyId, parsed.data);
    return url ? { status: "ok", url } : { status: "error" };
  } catch { return { status: "error" }; }
}
