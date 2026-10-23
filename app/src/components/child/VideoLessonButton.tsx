"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { getVideoLessonUrlAction, listTopicVideosAction } from "@/app/actions/video-lessons";
import { uk } from "@/i18n/uk";
import type { TopicVideoOption } from "@/server/lessons/videoLessons";

/**
 * S47 (PO decision 2026-10-27, extended 2026-10-23): "🎬 Відео-урок" — one
 * or more Pictory-generated videos attached to this topic, alongside
 * whatever text lesson it already has (never instead of it). Lives in both
 * the subject's topic list AND (S47 follow-up) every lesson viewer's own
 * nav bar, so it shows up no matter how the child reached this topic. Same
 * modal shell as `OpenVirtualBookButton.tsx` (portal into `document.body`,
 * same reasons: escapes any `backdrop-filter` ancestor).
 *
 * Nothing is signed until the child actually opens this: the video list
 * loads first (cheap), then — one video → plays immediately; several → a
 * picker, and only the PICKED one gets its playback URL signed.
 */
export function VideoLessonButton({ topicId, title }: { topicId: string; title?: string }) {
  const t = uk.child.subject.video;
  const modalTitle = title ?? t.button;
  const [open, setOpen] = useState(false);
  const [videos, setVideos] = useState<TopicVideoOption[] | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function show() {
    setOpen(true);
    setError(false);
    setUrl(null);
    const list = await listTopicVideosAction(topicId);
    setVideos(list);
    if (list.length === 1) void play(list[0]!.id);
    else if (list.length === 0) setError(true);
  }

  async function play(videoId: string) {
    setUrl(null);
    setError(false);
    const result = await getVideoLessonUrlAction(videoId);
    if (result.status === "ok") setUrl(result.url);
    else setError(true);
  }

  function close() {
    setOpen(false);
    setVideos(null);
    setUrl(null);
  }

  return (
    <>
      <button type="button" onClick={() => void show()} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold transition-transform active:scale-[0.97]">
        {t.button}
      </button>
      {open &&
        createPortal(
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4" onClick={close}>
            <div onClick={(e) => e.stopPropagation()} className="flex max-h-[95vh] w-[95vw] max-w-3xl flex-col overflow-hidden rounded-2xl bg-bg">
              <div className="flex items-center justify-between border-b border-line p-3">
                <p className="truncate text-sm font-bold">{modalTitle}</p>
                <button type="button" onClick={close} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-sm font-bold">
                  {t.close}
                </button>
              </div>
              <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 p-3">
                {error ? (
                  <p className="text-sm text-muted">{t.failed}</p>
                ) : url ? (
                  <video src={url} controls autoPlay preload="auto" className="max-h-[80vh] w-full rounded-xl" />
                ) : videos && videos.length > 1 ? (
                  <div className="flex w-full flex-wrap justify-center gap-2">
                    {videos.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => void play(v.id)}
                        className="min-h-11 rounded-full border-2 border-line bg-surface px-4 text-sm font-bold transition-transform active:scale-[0.97]"
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted">{t.loading}</p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
