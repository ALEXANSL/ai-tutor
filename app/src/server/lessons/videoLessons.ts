import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S47 (PO decision 2026-10-27, extended 2026-10-23): Pictory-generated
 * video lessons, uploaded by the parent and attached to an EXISTING topic
 * as a supplement — never a replacement for whatever text-lesson system
 * (literature/course/math_v2/literature_v2/literature_v3) already serves
 * that topic, or lack thereof. A topic can have SEVERAL videos (S47b,
 * 20261028100000) — every upload adds a new row, never replaces one; see
 * each migration's header for the storage-bucket/table shape.
 */

const VIDEO_BUCKET = "video_lessons";
const SIGNED_URL_TTL_S = 1800; // 30 minutes — comfortably more than one 3-5 min lesson, including seeking/rebuffering; still short-lived.

export interface VideoLessonRow {
  id: string;
  topicId: string;
  topicTitle: string;
  sizeBytes: number;
  createdAt: string;
}

export interface VideoLibraryRow extends VideoLessonRow { subjectId: string; subjectName: string; }
/** Parent library includes inactive subjects/courses; visibility rules apply only to child playback. */
export async function listVideoLibrary(familyId: string): Promise<VideoLibraryRow[]> {
  const { data, error } = await forFamily(familyId).select("video_lessons", "id,topic_id,subject_id,size_bytes,created_at,topics(title),subjects(name_uk)")
    .order("created_at", { ascending: false }).returns<{ id: string; topic_id: string; subject_id: string; size_bytes: number; created_at: string; topics: { title: string } | { title: string }[] | null; subjects: { name_uk: string } | { name_uk: string }[] | null }[]>();
  if (error) throw new Error("Не вдалося прочитати відеотеку.");
  return (data ?? []).map(row => ({ id: row.id, topicId: row.topic_id, topicTitle: (Array.isArray(row.topics) ? row.topics[0] : row.topics)?.title ?? "Тема недоступна", subjectId: row.subject_id, subjectName: (Array.isArray(row.subjects) ? row.subjects[0] : row.subjects)?.name_uk ?? "Предмет недоступний", sizeBytes: row.size_bytes, createdAt: row.created_at }));
}

export async function getParentVideoUrl(familyId: string, id: string, download = false): Promise<string | null> {
  const scope = forFamily(familyId);
  const { data, error } = await scope.select("video_lessons", "storage_path").eq("id", id).maybeSingle<{ storage_path: string }>();
  if (error) throw new Error("Не вдалося знайти відео.");
  if (!data || !data.storage_path.startsWith(`${familyId}/`)) return null;
  const extension = /\.(mp4|mov|webm)$/i.exec(data.storage_path)?.[1] ?? "mp4";
  const { data: signed, error: signError } = await scope.client.storage.from(VIDEO_BUCKET).createSignedUrl(data.storage_path, SIGNED_URL_TTL_S, download ? { download: `video-${id}.${extension}` } : undefined);
  if (signError || !signed) throw new Error("Не вдалося відкрити файл.");
  return signed.signedUrl;
}

/** New object is already verified by upload completion. Optimistic update preserves ID/topic/order and never deletes the old file before switching. */
export async function replaceVideoLesson(familyId: string, id: string, topicId: string, storagePath: string, mimeType: string, sizeBytes: number): Promise<{ id: string; cleanupPending: boolean }> {
  const scope = forFamily(familyId);
  const { data: old, error } = await scope.select("video_lessons", "storage_path,topic_id").eq("id", id).maybeSingle<{ storage_path: string; topic_id: string }>();
  if (error || !old || old.topic_id !== topicId || !old.storage_path.startsWith(`${familyId}/`) || !storagePath.startsWith(`${familyId}/${topicId}-`)) throw new Error("Не вдалося перевірити заміну відео.");
  if (old.storage_path === storagePath) return { id, cleanupPending: false };
  const oldPath = old.storage_path;
  const { data: updated, error: updateError } = await scope.update("video_lessons", { storage_path: storagePath, mime_type: mimeType, size_bytes: sizeBytes }).eq("id", id).eq("storage_path", oldPath).select("id").maybeSingle<{ id: string }>();
  if (updateError || !updated) throw new Error("Відео вже змінено або заміну не вдалося зберегти. Старий файл не видалено.");
  const removed = await scope.client.storage.from(VIDEO_BUCKET).remove([oldPath]).catch(() => ({ error: true }));
  return { id: updated.id, cleanupPending: !!removed.error };
}

/** Parent-facing list for the subject's content-admin panel (S42-style) — every video of the subject, newest first, several per topic included. */
export async function listVideoLessonsForSubject(familyId: string, subjectId: string): Promise<VideoLessonRow[]> {
  const scope = forFamily(familyId);
  const { data, error } = await scope.client
    .from("video_lessons")
    .select("id, topic_id, size_bytes, created_at, topics(title)")
    .eq("owner_family_id", familyId)
    .eq("subject_id", subjectId)
    .order("created_at", { ascending: false })
    .returns<{ id: string; topic_id: string; size_bytes: number; created_at: string; topics: { title: string } | { title: string }[] | null }[]>();
  if (error) throw new Error("Не вдалося завантажити список відеоматеріалів.");
  return (data ?? []).map((r) => {
    const topic = Array.isArray(r.topics) ? r.topics[0] : r.topics;
    return { id: r.id, topicId: r.topic_id, topicTitle: topic?.title ?? "?", sizeBytes: r.size_bytes, createdAt: r.created_at };
  });
}

/** Child-facing existence check for the subject screen's/lesson nav bar's "🎬 Відео-урок" button — no signed URL minted yet (only on open). */
export async function listTopicIdsWithVideoLesson(familyId: string, topicIds: string[]): Promise<Set<string>> {
  if (topicIds.length === 0) return new Set();
  const { data, error } = await forFamily(familyId)
    .select("video_lessons", "topic_id")
    .in("topic_id", topicIds)
    .returns<{ topic_id: string }[]>();
  if (error) { console.error("video lesson availability query failed", error.code); return new Set(); }
  return new Set((data ?? []).map((r) => r.topic_id));
}

/** Single-topic existence check for the in-lesson nav bar (`LessonNavBar`), every course-v2-style viewer (math_v2/literature_v2/literature_v3). */
export async function hasVideoLessonForTopic(familyId: string, topicId: string | null): Promise<boolean> {
  if (!topicId) return false;
  const ids = await listTopicIdsWithVideoLesson(familyId, [topicId]);
  return ids.has(topicId);
}

export interface TopicVideoOption {
  id: string;
  /** "Відео 1", "Відео 2"... by upload order — this format carries no per-video title (S47 kept intentionally simple; see migration header). */
  label: string;
  sizeBytes?: number;
}

/** The child's "🎬 Відео-урок" button fetches this list on open, before signing any URL — lets it show a picker when a topic has more than one video. */
export async function listTopicVideos(familyId: string, topicId: string): Promise<TopicVideoOption[]> {
  const { data } = await forFamily(familyId)
    .select("video_lessons", "id, created_at, size_bytes")
    .eq("topic_id", topicId)
    .order("created_at")
    .returns<{ id: string; created_at: string; size_bytes: number }[]>();
  return (data ?? []).map((r, i) => ({ id: r.id, label: `Відео ${i + 1}`, sizeBytes: r.size_bytes }));
}

/** Signs one video's playback URL on demand (not pre-signed on page load) — called when the child actually opens/picks it in the modal. */
export async function getVideoLessonUrlById(familyId: string, videoId: string): Promise<string | null> {
  const scope = forFamily(familyId);
  const { data, error: lookupError } = await scope.select("video_lessons", "storage_path,subject_id").eq("id", videoId).maybeSingle<{ storage_path: string; subject_id: string }>();
  if (lookupError) throw new Error("Не вдалося знайти відеоматеріал.");
  if (!data) return null;
  const subjectResult = await scope.select("subjects", "active,kind,group_id,is_stub").eq("id", data.subject_id)
    .maybeSingle<{ active: boolean; kind: string; group_id: string | null; is_stub: boolean }>();
  if (subjectResult.error) throw new Error("Не вдалося перевірити доступ до відео.");
  const subject = subjectResult.data;
  if (!subject || !subject.active || subject.is_stub) return null;
  if (subject.kind === "course" && subject.group_id) {
    const group = await scope.select("course_groups", "active").eq("id", subject.group_id).maybeSingle<{ active: boolean }>();
    if (group.error) throw new Error("Не вдалося перевірити доступ до курсу.");
    if (!group.data?.active) return null;
  }
  if (!data.storage_path.startsWith(`${familyId}/`)) return null;
  const { data: signed, error } = await scope.client.storage.from(VIDEO_BUCKET).createSignedUrl(data.storage_path, SIGNED_URL_TTL_S);
  if (error || !signed) throw new Error("Не вдалося відкрити відеофайл.");
  return signed.signedUrl;
}

/** Called by the upload-complete route once the browser has PUT the file straight to Storage. Always adds a NEW row (S47b: several videos per topic) — returns its id for the panel's delete button. */
export async function saveVideoLesson(
  familyId: string,
  topicId: string,
  subjectId: string,
  storagePath: string,
  mimeType: string,
  sizeBytes: number,
): Promise<string> {
  const scope = forFamily(familyId);
  const { data, error } = await scope
    .insert("video_lessons", { topic_id: topicId, subject_id: subjectId, storage_path: storagePath, mime_type: mimeType, size_bytes: sizeBytes })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`saving the video lesson failed: ${error?.message}`);
  return data.id;
}

/** Parent delete (S42-style panel) — removes both the DB row and the stored file. */
export async function deleteVideoLesson(familyId: string, id: string): Promise<{ cleanupPending: boolean }> {
  const scope = forFamily(familyId);
  const { data } = await scope.select("video_lessons", "storage_path").eq("id", id).maybeSingle<{ storage_path: string }>();
  if (!data || !data.storage_path.startsWith(`${familyId}/`)) throw new Error("video lesson not found");
  const { data: deleted, error } = await scope.delete("video_lessons").eq("id", id).eq("storage_path", data.storage_path).select("id").maybeSingle<{ id: string }>();
  if (error || !deleted) throw new Error("Відео змінилося або видалення не вдалося. Оновіть список.");
  const removed = await scope.client.storage.from(VIDEO_BUCKET).remove([data.storage_path]).catch(() => ({ error: true }));
  return { cleanupPending: !!removed.error };
}
