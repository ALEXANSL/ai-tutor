"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getVideoLessonUrlAction, listTopicVideosAction } from "@/app/actions/video-lessons";
import { stopCurrentlyPlaying } from "@/components/shared/singleAudioPlayback";
import type { TopicVideoOption } from "@/server/lessons/videoLessons";
import { uk } from "@/i18n/uk";

/** Optional supplement; never changes the underlying lesson or its progress. */
export function VideoLessonButton({ topicId, title, videoId }: { topicId: string; title?: string; videoId?: string }) {
  const t = uk.child.subject.video;
  const modalTitle = title ?? t.button;
  const [videos, setVideos] = useState<TopicVideoOption[] | null>(null);
  const selected = useRef<string | null>(videoId ?? null);
  const [buffered, setBuffered] = useState(0);
  const [target, setTarget] = useState(60);
  const [prepared, setPrepared] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [preloadLimited, setPreloadLimited] = useState(false);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const sequence = useRef(0);
  const headingId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const close = useCallback(() => {
    sequence.current++;
    video.current?.pause();
    setOpen(false); setUrl(null); setError(false); setVideos(null); setPrepared(false); setBuffering(false);
  }, []);

  function updateBuffer() {
    const element = video.current;
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return;
    const goal = Math.min(60, element.duration);
    let ahead = 0;
    for (let index = 0; index < element.buffered.length; index++) {
      if (element.buffered.start(index) <= element.currentTime + 0.1 && element.buffered.end(index) >= element.currentTime) {
        ahead = element.buffered.end(index) - element.currentTime; break;
      }
    }
    setTarget(goal); setBuffered(Math.max(0, ahead));
    if (ahead >= goal - 0.25) setPrepared(true);
  }
  async function requestUrl(id: string) {
    const ticket = ++sequence.current;
    selected.current = id;
    setError(false); setUrl(null); setPrepared(false); setBuffered(0); setTarget(60); setPreloadLimited(false);
    try {
      const result = await getVideoLessonUrlAction(id);
      if (ticket !== sequence.current) return;
      if (result.status === "ok") setUrl(result.url); else setError(true);
    } catch { if (ticket === sequence.current) setError(true); }
  }
  async function load() {
    if (videoId) { await requestUrl(videoId); return; }
    const ticket = ++sequence.current;
    setError(false); setUrl(null); setVideos(null); selected.current = null;
    try {
      const list = await listTopicVideosAction(topicId);
      if (ticket !== sequence.current) return;
      setVideos(list);
      if (list.length === 1) await requestUrl(list[0]!.id);
      else if (!list.length) setError(true);
    } catch { if (ticket === sequence.current) setError(true); }
  }
  function show() {
    // Stop active/pending TTS and voice capture before showing the player.
    window.dispatchEvent(new Event("lesson-navigation"));
    stopCurrentlyPlaying();
    document.querySelectorAll<HTMLMediaElement>("audio,video").forEach(media => media.pause());
    setOpen(true);
    void load();
  }
  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const targets = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),video[controls],[tabindex="0"]');
        if (!targets?.length) return;
        const first = targets[0]!, last = targets[targets.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keys);
    window.addEventListener("lesson-navigation", close);
    window.addEventListener("pagehide", close);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keys);
      window.removeEventListener("lesson-navigation", close);
      window.removeEventListener("pagehide", close);
      if (previous?.isConnected) previous.focus(); else trigger.current?.focus();
    };
  }, [open, close]);
  useEffect(() => {
    const element = video.current;
    return () => { element?.pause(); };
  }, [url]);

  return <>
    <button ref={trigger} type="button" onClick={show} disabled={open} className="inline-flex min-h-12 items-center rounded-2xl border-2 border-line bg-surface px-4 text-base font-bold">{t.button}</button>
    {open && createPortal(
      <div role="dialog" aria-modal="true" aria-labelledby={headingId} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-2 sm:p-4" onClick={close}>
        <div ref={dialog} onClick={event => event.stopPropagation()} className="flex max-h-[95dvh] w-full max-w-4xl flex-col overflow-auto rounded-2xl bg-bg">
          <div className="flex items-center justify-between gap-3 border-b border-line p-3">
            <h2 id={headingId} className="min-w-0 text-base font-bold">{modalTitle}</h2>
            <button type="button" onClick={close} className="min-h-12 shrink-0 rounded-full border-2 border-line bg-surface px-4 font-bold">{t.close}</button>
          </div>
          <div className="flex min-h-[200px] flex-col items-center justify-center gap-4 p-3">
            {error ? <><p role="alert" className="text-sm text-muted">{t.failed}</p><button type="button" onClick={() => void (selected.current ? requestUrl(selected.current) : load())} className="min-h-12 rounded-xl bg-primary px-4 font-bold text-white">Спробувати ще раз</button></>
              : url ? <>
                <video ref={video} src={url} controls={prepared} playsInline preload="auto"
                  onLoadedMetadata={updateBuffer} onProgress={updateBuffer} onCanPlay={updateBuffer} onCanPlayThrough={updateBuffer}
                  onTimeUpdate={updateBuffer} onWaiting={() => setBuffering(true)} onPlaying={() => setBuffering(false)}
                  onSuspend={() => { updateBuffer(); setPreloadLimited(true); }} onError={() => setError(true)} onPlay={() => {
                    setPrepared(true); stopCurrentlyPlaying();
                    document.querySelectorAll<HTMLMediaElement>("audio,video").forEach(media => { if (media !== video.current) media.pause(); });
                  }} className="max-h-[65dvh] w-full rounded-xl bg-black" />
                {!prepared && <div role="status" className="w-full space-y-2 text-sm">
                  <p>Готую запас відео перед переглядом: {Math.floor(buffered)} із {Math.ceil(target)} с.</p>
                  <progress className="w-full" value={Math.min(buffered, target)} max={target} aria-label="Підготовка запасу відео" />
                  {preloadLimited && buffered > 0 && <p className="text-muted">Браузер може обмежувати попереднє завантаження. Можна почати з уже підготовленого фрагмента.</p>}
                  {buffered >= Math.min(3, target) && <button type="button" className="min-h-12 rounded-xl bg-primary px-4 font-bold text-white" onClick={() => { setPrepared(true); void video.current?.play().catch(() => {}); }}>Почати зараз</button>}
                </div>}
                {prepared && buffering && <p role="status" className="text-sm text-muted">Підвантажую наступний фрагмент відео…</p>}
              </> : videos && videos.length > 1 ? <div className="flex flex-wrap gap-3">{videos.map(item => <button type="button" key={item.id} onClick={() => void requestUrl(item.id)} className="min-h-12 rounded-xl border border-line px-4 font-bold">{item.label}</button>)}</div>
                : <p role="status" className="text-sm text-muted">{t.loading}</p>}
          </div>
        </div>
      </div>, document.body)}
  </>;
}
