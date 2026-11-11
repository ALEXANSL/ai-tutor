"use client";
import { useEffect, useRef, useState } from "react";
import { audioPositionAction } from "@/app/actions/audiobooks";
import type { AudioPosition } from "@/server/audiobooks/positions";
export function AudiobookPlayer({ id, segments, preview = false }: { id: string; segments: { text: string; ready: boolean }[]; preview?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null); const [position, setPosition] = useState<AudioPosition>({ segment: 0, seconds: 0, speed: 1, bookmark: null });
  const current = useRef(position); const [restored, setRestored] = useState(preview), [error, setError] = useState(""); const playNext = useRef(false), lastSaved = useRef(0);
  const segment = position.segment; const chunk = segments[segment];
  useEffect(() => { current.current = position; }, [position]);
  useEffect(() => {
    let live = true;
    if (preview) return;
    void audioPositionAction(id).then(value => { if (live && value && value.segment < segments.length) { current.current = value; setPosition(value); } }).catch(() => { if (live) setError("Не вдалося відновити місце зупинки. Читання можна почати спочатку."); }).finally(() => { if (live) setRestored(true); });
    return () => { live = false; };
  }, [id, preview, segments.length]);
  async function persist(value = current.current) { if (preview || !restored) return; try { await audioPositionAction(id, value); } catch { setError("Не вдалося зберегти позицію. Перевір з’єднання."); } }
  useEffect(() => {
    const element = audio.current;
    const stop = () => { element?.pause(); };
    const hide = () => { if (document.hidden) element?.pause(); };
    window.addEventListener("lesson-navigation", stop); document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("lesson-navigation", stop); document.removeEventListener("visibilitychange", hide); element?.pause(); };
  }, []);
  function jump(index: number, seconds = 0, autoplay = false) {
    if (index < 0 || index >= segments.length || !segments[index]?.ready) return;
    audio.current?.pause(); playNext.current = autoplay; const next = { ...current.current, segment: index, seconds }; current.current = next; setPosition(next);
    if (index === segment && audio.current) { audio.current.currentTime = seconds; if (autoplay) void audio.current.play().catch(() => setError("Натисни відтворення, щоб продовжити.")); }
    void persist(next);
  }
  function onTime() { const a = audio.current; if (!a || current.current.segment !== segment) return; current.current = { ...current.current, seconds: a.currentTime }; if (Date.now() - lastSaved.current > 15000) { lastSaved.current = Date.now(); void persist(); } }
  function loaded() { const a = audio.current; if (!a) return; a.playbackRate = current.current.speed; if (current.current.seconds > 0 && Number.isFinite(a.duration)) a.currentTime = Math.min(current.current.seconds, Math.max(0, a.duration - 0.1)); if (playNext.current) { playNext.current = false; void a.play().catch(() => setError("Натисни відтворення, щоб продовжити.")); } }
  return <section className="min-w-0 rounded-2xl border border-line bg-surface p-5"><h2 className="text-xl font-extrabold">🎧 {preview ? "Прослухати перед публікацією" : "Слухаємо книгу"}</h2><p className="mt-2 text-sm text-muted">Голос створено ШІ. Фрагмент {segment + 1} із {segments.length}. {preview ? "Це приватний перегляд." : "Місце зупинки зберігається."}</p>{restored && chunk?.ready ? <audio key={`${id}:${segment}`} ref={audio} controls preload="auto" src={`/api/${preview ? "parent/" : ""}audiobooks/${id}/${segment}`} onLoadedMetadata={loaded} onTimeUpdate={onTime} onPause={() => { onTime(); void persist(); }} onEnded={() => { if (segment < segments.length - 1) jump(segment + 1, 0, true); else { current.current = { ...current.current, seconds: audio.current?.duration || 0 }; void persist(); } }} onError={() => setError("Не вдалося завантажити аудіо. Повтори відкриття фрагмента.")} className="mt-5 w-full" /> : <p className="mt-5 text-muted">{restored ? "Цей фрагмент ще готується." : "Відновлюємо позицію…"}</p>}
  <div className="mt-4 flex flex-wrap gap-2"><button onClick={() => jump(segment - 1)} disabled={!segment || !segments[segment - 1]?.ready} className="min-h-11 rounded-xl border border-line px-3 font-bold disabled:opacity-40">← Фрагмент</button><button onClick={() => { if (audio.current) audio.current.currentTime = Math.max(0, audio.current.currentTime - 15); }} className="min-h-11 rounded-xl border border-line px-3 font-bold">−15 с</button><button onClick={() => { const a = audio.current; if (a && Number.isFinite(a.duration)) a.currentTime = Math.min(a.duration, a.currentTime + 15); }} className="min-h-11 rounded-xl border border-line px-3 font-bold">+15 с</button><button onClick={() => jump(segment + 1)} disabled={segment >= segments.length - 1 || !segments[segment + 1]?.ready} className="min-h-11 rounded-xl border border-line px-3 font-bold disabled:opacity-40">Фрагмент →</button><label className="flex min-h-11 items-center gap-2 rounded-xl border border-line px-3">Швидкість<select aria-label="Швидкість читання" value={position.speed} onChange={e => { const speed = Number(e.target.value); if (audio.current) audio.current.playbackRate = speed; const next = { ...current.current, speed }; current.current = next; setPosition(next); void persist(next); }} className="bg-surface">{[0.75, 1, 1.25, 1.5, 1.75, 2].map(v => <option key={v} value={v}>{v}×</option>)}</select></label></div>
  {!preview && <div className="mt-3 flex flex-wrap gap-2"><button className="min-h-11 rounded-xl border border-line px-3 font-bold" onClick={() => { const next = { ...current.current, bookmark: { segment, seconds: audio.current?.currentTime ?? current.current.seconds } }; current.current = next; setPosition(next); void persist(next); }}>🔖 Закладка тут</button>{position.bookmark && <button className="min-h-11 rounded-xl border border-line px-3 font-bold" onClick={() => jump(position.bookmark!.segment, position.bookmark!.seconds)}>До закладки</button>}</div>}
  {restored && segments[segment + 1]?.ready && <audio aria-hidden="true" className="hidden" preload="auto" src={`/api/${preview ? "parent/" : ""}audiobooks/${id}/${segment + 1}`} />}
  <label className="mt-4 block text-sm font-bold">Перейти до фрагмента<select value={segment} aria-label="Перейти до фрагмента" onChange={e => jump(Number(e.target.value))} className="mt-2 min-h-11 w-full rounded-xl border border-line bg-surface p-2">{segments.map((s, i) => <option value={i} key={i} disabled={!s.ready}>{i + 1}. {s.text.trim().slice(0, 60)}{!s.ready ? " — готується" : ""}</option>)}</select></label><details className="mt-5"><summary className="cursor-pointer font-bold">Текст поточного фрагмента</summary><p className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap leading-relaxed">{chunk?.text}</p></details>{error && <p role="status" className="mt-3 text-sm text-muted">{error}</p>}</section>;
}
