"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { listSubjectTopicsForVideoAction } from "@/app/actions/video-lessons";
import { withBusySignal } from "@/lib/busy-signal";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { MAX_VIDEO_LESSON_BYTES } from "@/lib/upload-limits";
import type { SubjectOption } from "@/server/books/queries";
import type { TopicOption } from "@/server/subjects/queries";
import { uk } from "@/i18n/uk";
import { parentButton, parentInput } from "@/app/parent/ui";

/**
 * S47 follow-up (Алекс 2026-10-23, "чому не з'явився інтерфейс"): the
 * subject-detail page's own "Відео-уроки" panel (buried under "Контент і
 * обслуговування") was never where a parent looks for an upload — every
 * OTHER import type lives here, on "Завантажити матеріали", with its own
 * subject picker. Same upload mechanism (signed Storage URL), topic
 * dropdown loads only after a subject is picked (one topic list per
 * subject, not all of them up front).
 */
export function VideoLessonUploadPanel({ subjects }: { subjects: SubjectOption[] }) {
  const t = uk.parent.contentAdmin.videoLessons;
  const [subjectId, setSubjectId] = useState("");
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const [topicId, setTopicId] = useState("");
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "done">("idle");
  const [message, setMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);

  async function onSubjectChange(value: string) {
    setSubjectId(value);
    setTopicId("");
    setTopics([]);
    setMessage("");
    setPhase("idle");
    if (!value) return;
    setLoadingTopics(true);
    try {
      setTopics(await listSubjectTopicsForVideoAction(value));
    } finally {
      setLoadingTopics(false);
    }
  }

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

        setPhase("done");
        setMessage(t.done);
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.failed);
      setPhase("idle");
    } finally {
      lock.current = false;
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const busy = phase === "uploading";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-p-muted">{t.hint}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-bold text-p-text">
          Предмет
          <select className={parentInput} value={subjectId} disabled={busy} onChange={(e) => void onSubjectChange(e.target.value)}>
            <option value="">Оберіть предмет</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-bold text-p-text">
          {t.topicLabel}
          <select className={parentInput} value={topicId} disabled={busy || !subjectId || loadingTopics} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">{loadingTopics ? "Завантажую теми…" : topics.length === 0 && subjectId ? "У предмета ще немає тем" : t.pickTopic}</option>
            {topics.map((tp) => (
              <option key={tp.id} value={tp.id}>{tp.title}</option>
            ))}
          </select>
        </label>
      </div>

      <div>
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
        <button type="button" disabled={busy || !topicId} onClick={() => fileInput.current?.click()} className={parentButton}>
          {busy ? t.uploading : `📤 ${t.uploadButton}`}
        </button>
      </div>

      {message && (
        <p role={phase === "done" ? "status" : "alert"} className={`text-sm font-bold ${phase === "done" ? "text-p-success" : "text-p-danger"}`}>
          {message}
        </p>
      )}
      {phase === "done" && subjectId && (
        <Link href={`/parent/subjects/${subjectId}`} className="text-sm font-semibold text-p-primary underline">
          Переглянути відео-уроки цього предмета →
        </Link>
      )}
    </div>
  );
}
