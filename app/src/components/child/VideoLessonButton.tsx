"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { getVideoLessonUrlAction } from "@/app/actions/video-lessons";
import { uk } from "@/i18n/uk";

/**
 * S47 (PO decision 2026-10-27): "🎬 Відео-урок" — a Pictory-generated video
 * attached to this topic, alongside whatever text lesson it already has
 * (never instead of it). Same modal shell as `OpenVirtualBookButton.tsx`
 * (portal into `document.body`, same reasons: escapes any `backdrop-filter`
 * ancestor). The playback URL is signed on demand, only once the child
 * actually opens the modal — never pre-signed on the subject screen's
 * initial load.
 */
export function VideoLessonButton({ topicId, title }: { topicId: string; title: string }) {
  const t = uk.child.subject.video;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function show() {
    setOpen(true);
    setError(false);
    const result = await getVideoLessonUrlAction(topicId);
    if (result.status === "ok") setUrl(result.url);
    else setError(true);
  }

  function close() {
    setOpen(false);
    setUrl(null);
  }

  return (
    <>
      <button type="button" onClick={() => void show()} className="inline-flex min-h-12 items-center rounded-2xl border-2 border-line bg-surface px-4 text-base font-bold">
        {t.button}
      </button>
      {open &&
        createPortal(
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4" onClick={close}>
            <div onClick={(e) => e.stopPropagation()} className="flex max-h-[95vh] w-[95vw] max-w-3xl flex-col overflow-hidden rounded-2xl bg-bg">
              <div className="flex items-center justify-between border-b border-line p-3">
                <p className="truncate text-sm font-bold">{title}</p>
                <button type="button" onClick={close} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-sm font-bold">
                  {t.close}
                </button>
              </div>
              <div className="flex min-h-[200px] items-center justify-center p-3">
                {error ? (
                  <p className="text-sm text-muted">{t.failed}</p>
                ) : url ? (
                  <video src={url} controls autoPlay className="max-h-[80vh] w-full rounded-xl" />
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
