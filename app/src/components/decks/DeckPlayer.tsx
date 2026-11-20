"use client";
import { useEffect, useRef, useState } from "react";
import { loadPdfDocument, renderPdfPage, isRenderCancelledError, type PdfRenderTaskLike, type PdfPageProxyLike } from "@/components/child/pdfEngine";

export function DeckPlayer({ id, scripts, preview = false }: { id: string; scripts: string[]; preview?: boolean }) {
  const [index, setIndex] = useState(0), [drawn, setDrawn] = useState(-1), [error, setError] = useState("");
  const [auto, setAuto] = useState(true);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  useEffect(() => { setFullscreenAvailable(document.fullscreenEnabled); }, []);
  const viewer = useRef<HTMLElement>(null);
  const audio = useRef<HTMLAudioElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const continuePlaying = useRef(false);
  const renderTaskRef = useRef<PdfRenderTaskLike | null>(null), prevPageRef = useRef<PdfPageProxyLike | null>(null);
  const base = `/api/presentations/${id}/`, suffix = preview ? "?preview=1" : "";
  useEffect(() => {
    let active = true;
    const surface = canvas.current!;
    setError(""); setDrawn(-1);
    loadPdfDocument(base + suffix, base + "slides.pdf" + suffix)
      .then(async doc => {
        if (!active) return;
        await renderPdfPage({ doc, pageNum: index + 1, canvas: surface, maxRenderWidth: Math.max(1100, surface.clientWidth * 1.5), refs: { renderTaskRef, prevPageRef } });
        if (active) setDrawn(index);
      }).catch(e => { if (active && !isRenderCancelledError(e)) setError("Не вдалося показати слайд. Онови сторінку."); });
    return () => { active = false; renderTaskRef.current?.cancel(); };
  }, [index, base, suffix]);
  useEffect(() => {
    if (drawn !== index || !continuePlaying.current) return;
    continuePlaying.current = false;
    void audio.current?.play().catch(() => setError("Натисни відтворення, щоб продовжити слухати."));
  }, [drawn, index]);
  function go(n: number, play = audio.current?.paused === false) {
    audio.current?.pause(); continuePlaying.current = play; setIndex(n);
  }
  const button = "min-h-12 rounded-xl border border-current px-4 disabled:opacity-40";
  return <section ref={viewer} className="space-y-3 overflow-auto bg-surface p-3 fullscreen:p-5" aria-label="Презентація з озвученням">
    <nav aria-label="Переходи між слайдами" className="flex flex-wrap items-center gap-2"><button className={button} disabled={!index} onClick={() => go(index - 1)}>← Назад</button><label>Слайд <select className={button} value={index} onChange={e => go(Number(e.target.value))}>{scripts.map((_, i) => <option key={i} value={i}>{i + 1} із {scripts.length}</option>)}</select></label><button className={button} disabled={index + 1 >= scripts.length} onClick={() => go(index + 1)}>Далі →</button>
    {fullscreenAvailable && <button className={button} onClick={async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await viewer.current?.requestFullscreen();
      } catch { setError("Цей браузер не зміг відкрити повний екран."); }
    }}>Повний екран</button>}</nav>
    <div className="grid h-[clamp(12rem,56dvh,40rem)] place-items-center overflow-hidden rounded-xl bg-black fullscreen:flex-1"><canvas key={`slide-${index}`} ref={canvas} aria-label={`Слайд ${index + 1}`} className="block h-full w-full object-contain" /></div>
    {error && <p role="alert">{error}</p>}
    <audio key={`voice-${index}`} ref={audio} controls preload="metadata" className="w-full" aria-label="Голос лектора" src={base + (index + 1) + ".mp3" + suffix} onError={() => setError("Не вдалося завантажити озвучення.")} onEnded={() => { if (auto && index + 1 < scripts.length) go(index + 1, true); }} />
    <div><label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Автоперехід після озвучення</label></div>
    <details><summary className="cursor-pointer py-3 font-bold">Текст пояснення</summary><p className="whitespace-pre-line">{scripts[index]}</p></details>
  </section>;
}
