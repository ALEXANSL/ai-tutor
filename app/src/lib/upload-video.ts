"use client";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { MAX_VIDEO_LESSON_BYTES } from "@/lib/upload-limits";

/** Bytes go directly to private Storage; completion verifies metadata before changing any binding. */
export async function uploadReplacementVideo(file: File, topicId: string, replaceVideoId: string): Promise<{ cleanupPending: boolean }> {
  if (!file.size || file.size > MAX_VIDEO_LESSON_BYTES) throw new Error(`Обери відео до ${MAX_VIDEO_LESSON_BYTES / 1024 / 1024} МБ.`);
  const mimeType = file.type || "video/mp4";
  const init = await fetch("/api/parent/video-lessons/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId, fileName: file.name, mimeType, size: file.size }) });
  if (!init.ok) throw new Error("Не вдалося почати завантаження. Підтримуються MP4, WebM і MOV.");
  const { path, token } = await init.json() as { path: string; token: string };
  const storage = getBrowserSupabaseStorageClient();
  if (!storage) throw new Error("Сховище недоступне. Онови сторінку.");
  const { error } = await storage.storage.from("video_lessons").uploadToSignedUrl(path, token, file, { contentType: mimeType, cacheControl: "31536000" });
  if (error) throw new Error("Завантаження не завершилося. Поточне відео не змінено.");
  const complete = await fetch("/api/parent/video-lessons/upload/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId, storagePath: path, mimeType, sizeBytes: file.size, replaceVideoId }) });
  if (!complete.ok) throw new Error("Не вдалося підтвердити заміну. Онови відеотеку перед повторною спробою.");
  const result = await complete.json() as { cleanupPending?: boolean };
  return { cleanupPending: !!result.cleanupPending };
}
