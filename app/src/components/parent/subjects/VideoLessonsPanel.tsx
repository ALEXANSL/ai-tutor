"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteVideoLessonAction } from "@/app/actions/video-lessons";
import { withBusySignal } from "@/lib/busy-signal";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { MAX_VIDEO_LESSON_BYTES } from "@/lib/upload-limits";
import { uk } from "@/i18n/uk";
import type { VideoLessonRow } from "@/server/lessons/videoLessons";

export interface VideoTopicOption {
  id: string;
  title: string;
}

/**
 * S47 (PO decision 2026-10-27, Алекс: "давай спробуємо додати" три готові
 * Pictory-відеоуроки з історії) — parent picks one of this subject's
 * EXISTING topics by its own title (no new entity, no subject picker: this
 * panel already lives inside that subject's own detail page) and uploads
 * the video file. Same signed-upload-URL mechanism as
 * `UnifiedCourseImportPanel.tsx` (browser → Supabase Storage directly,
 * bypassing Vercel's ~4.5 MB function body limit).
 */
export function VideoLessonsPanel({ topics, initialVideos }: { topics: VideoTopicOption[]; initialVideos: VideoLessonRow[] }) {
  const t = uk.parent.contentAdmin.videoLessons;
  const router = useRouter();
  // S47 fix (2026-10-23, Алекс: завантажив відео для теми, що виявилась
  // прихованою від дитини — відео зберіглося, кнопка ніде не з'явилась):
  // `topics` here is ALREADY the same filtered list the child's own
  // `/subject/[id]` screen renders (see `getSubjectDetail`'s visibility
  // rule) — a video whose `topicId` isn't in it will never have anywhere to
  // show up, so flag it right here instead of letting that be a silent gap.
  const visibleTopicIds = new Set(topics.map((tp) => tp.id));
  const [videos, setVideos] = useState(initialVideos);
  const [topicId, setTopicId] = useState("");
  const [phase, setPhase] = useState<"idle" | "uploading" | "done">("idle");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);

  async function upload(file: File) {
    if (lock.current) return;
    if (!topicId) { setMessage(t.pickTopicFirst); return; }
    if (!file.size || file.size > MAX_VIDEO_LESSON_BYTES) {
      setMessage(t.tooLarge(MAX_VIDEO_LESSON_BYTES / 1024 / 1024));
      return;
    }
    lock.current = true;
    setMessage("");
    setPhase("uploading");
    try {
      await withBusySignal(async () => {
        const mimeType = file.type || "video/mp4";
        const init = await fetch("/api/parent/video-lessons/upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topicId, fileName: file.name, mimeType, size: file.size }),
        });
        if (!init.ok) {
          const body = (await init.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error === "too_large" ? t.tooLarge(MAX_VIDEO_LESSON_BYTES / 1024 / 1024) : body?.error === "unsupported_type" ? t.unsupportedType : t.failed);
        }
        const upload = (await init.json()) as { path: string; token: string };
        const client = getBrowserSupabaseStorageClient();
        if (!client) throw new Error(t.notConfigured);
        const { error } = await client.storage.from("video_lessons").uploadToSignedUrl(upload.path, upload.token, file);
        if (error) throw new Error(t.failed);

        const complete = await fetch("/api/parent/video-lessons/upload/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topicId, storagePath: upload.path, mimeType, sizeBytes: file.size }),
        });
        if (!complete.ok) throw new Error(t.failed);
        const { id } = (await complete.json()) as { id: string };

        const topicTitle = topics.find((tp) => tp.id === topicId)?.title ?? "?";
        setVideos((prev) => [{ id, topicId, topicTitle, sizeBytes: file.size, createdAt: new Date().toISOString() }, ...prev.filter((v) => v.topicId !== topicId)]);
        setPhase("done");
        setMessage(t.done);
        router.refresh();
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.failed);
      setPhase("idle");
    } finally {
      lock.current = false;
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(video: VideoLessonRow) {
    if (!window.confirm(t.deleteConfirm)) return;
    setBusyId(video.id);
    setMessage("");
    const result = await withBusySignal(() => deleteVideoLessonAction(video.id));
    setBusyId(null);
    if (result.status === "error") {
      setMessage(result.message);
      return;
    }
    setVideos((prev) => prev.filter((v) => v.id !== video.id));
  }

  const busy = phase === "uploading";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-p-muted">{t.hint}</p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="flex flex-col gap-1.5 text-[13px] font-bold text-p-text">
          {t.topicLabel}
          <select className="min-h-11 w-full rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary" value={topicId} disabled={busy} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">{t.pickTopic}</option>
            {topics.map((tp) => (
              <option key={tp.id} value={tp.id}>{tp.title}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 self-end text-[13px] font-bold text-p-text">
          <input
            ref={fileInput}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            disabled={busy || !topicId}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <button
            type="button"
            disabled={busy || !topicId}
            onClick={() => fileInput.current?.click()}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60"
          >
            {busy ? t.uploading : `📤 ${t.uploadButton}`}
          </button>
        </label>
      </div>
      {message && (
        <p role={phase === "done" ? "status" : "alert"} className={`text-[13px] font-bold ${phase === "done" ? "text-p-success" : "text-p-danger"}`}>
          {message}
        </p>
      )}

      {videos.length === 0 ? (
        <p className="text-[13px] text-p-muted">{t.empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-p-line rounded-xl border border-p-line">
          {videos.map((video) => (
            <li key={video.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate font-bold">🎬 {video.topicTitle}</span>
              {!visibleTopicIds.has(video.topicId) && (
                <span className="shrink-0 rounded-full bg-p-danger/10 px-2 py-0.5 text-[10.5px] font-extrabold text-p-danger" title={t.hiddenTopicWarningHint}>
                  {t.hiddenTopicWarning}
                </span>
              )}
              <span className="shrink-0 text-[11.5px] text-p-muted">{(video.sizeBytes / 1024 / 1024).toFixed(1)} МБ</span>
              <button
                type="button"
                onClick={() => remove(video)}
                disabled={busyId === video.id}
                className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] font-bold text-p-danger disabled:cursor-not-allowed disabled:text-p-muted"
              >
                {t.delete}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
