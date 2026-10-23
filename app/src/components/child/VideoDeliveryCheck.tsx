"use client";
import { useEffect, useRef, useState } from "react";
import { inspectVideoDeliveryAction } from "@/app/actions/video-lessons";
import { probeVideoDelivery } from "@/lib/video-delivery-probe";

/** Opt-in troubleshooting: no identifiers/URLs/audio/child profile in report. */
export function VideoDeliveryCheck({ videoId, url, media, onSuspendPlayback, onBusyChange }: { videoId: string; url: string; media: () => HTMLVideoElement | null; onSuspendPlayback: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [report, setReport] = useState("");
  const [notice, setNotice] = useState("");
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; abort.current?.abort(); }; }, []);
  async function inspect() {
    if (abort.current) return;
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); onBusyChange?.(true); setReport(""); setNotice("");
    const element = media();
    const quality = element?.getVideoPlaybackQuality?.();
    const playback = element ? { durationSeconds: Number.isFinite(element.duration) ? element.duration : null, resolution: `${element.videoWidth}x${element.videoHeight}`, droppedFrames: quality?.droppedVideoFrames ?? null, totalFrames: quality?.totalVideoFrames ?? null, mediaError: element.error?.code ?? null } : null;
    // Abort media fetching so a second download doesn't distort this test.
    onSuspendPlayback();
    try {
      const browser = await probeVideoDelivery(url, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const server = await inspectVideoDeliveryAction(videoId);
      if (!mounted.current || controller.signal.aborted) return;
      setReport(JSON.stringify({ version: 1, playback, browser, server: server.status === "ok" ? server.report : "unavailable" }, null, 2));
    } catch { if (mounted.current) setNotice("Перевірку не завершено. Спробуй ще раз."); }
    finally { abort.current = null; if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
  }
  async function copyReport() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(report); setNotice("Звіт скопійовано.");
    } catch { setNotice("Виділи й скопіюй текст звіту вручну."); }
  }
  return <details className="w-full border-t border-line pt-3 text-sm">
    <summary className="cursor-pointer text-muted">Проблеми з переглядом?</summary>
    <p className="my-2 text-muted">Перевірка призупинить відео й виміряє завантаження невеликого фрагмента. Звіт можна передати татові.</p>
    <button type="button" disabled={busy} onClick={() => void inspect()} className="min-h-11 rounded-xl border border-line px-3 font-bold">{busy ? "Перевіряю завантаження…" : "Перевірити завантаження"}</button>
    {report && <><p role="status" className="my-2">Звіт готовий. Приватних посилань і ключів у ньому немає.</p><textarea readOnly value={report} aria-label="Звіт перевірки відео" className="h-40 w-full rounded-xl border border-line bg-bg p-2 font-mono text-xs" /><button type="button" className="min-h-11 rounded-xl border border-line px-3 font-bold" onClick={() => void copyReport()}>Скопіювати звіт</button></>}
    {notice && <p role="status" className="mt-2 text-muted">{notice}</p>}
  </details>;
}
