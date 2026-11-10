"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteVideoLessonAction, getParentVideoUrlAction } from "@/app/actions/video-lessons";
import type { VideoLibraryRow } from "@/server/lessons/videoLessons";
import { withBusySignal } from "@/lib/busy-signal";
import { uploadReplacementVideo } from "@/lib/upload-video";
import { parentButton, parentInput } from "@/app/parent/ui";

const cleanupNotice = "Зміни збережено, але старий файл не вдалося прибрати зі сховища. Він більше не використовується; для очищення потрібна перевірка сховища.";
export function VideoLibrary({ videos, timeZone, initialSubjectId = "" }: { videos: VideoLibraryRow[]; timeZone: string; initialSubjectId?: string }) {
  const router = useRouter();
  const [items, setItems] = useState(videos);
  const [previousVideos, setPreviousVideos] = useState(videos);
  if (previousVideos !== videos) { setPreviousVideos(videos); setItems(videos); }
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState(videos.some(video => video.subjectId === initialSubjectId) ? initialSubjectId : "");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const media = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const replacement = useRef<VideoLibraryRow | null>(null);
  useEffect(() => { if (preview && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [preview]);
  useEffect(() => { const video = media.current; return () => { if (video) { video.pause(); video.removeAttribute("src"); video.load(); } }; }, [preview]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (lock.current) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, []);
  async function run(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try { await withBusySignal(operation); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Дію не завершено. Онови список і спробуй ще раз."); }
    finally { lock.current = false; setBusy(false); }
  }
  async function open(video: VideoLibraryRow, download: boolean) {
    await run(async () => {
      const result = await getParentVideoUrlAction(video.id, download);
      if (result.status !== "ok") throw new Error("Не вдалося отримати відеофайл. Спробуй ще раз.");
      if (download) { const link = document.createElement("a"); link.href = result.url; link.download = ""; document.body.append(link); link.click(); link.remove(); }
      else setPreview({ url: result.url, title: video.topicTitle });
    });
  }
  async function remove(video: VideoLibraryRow) {
    if (!window.confirm(`Видалити відео до теми «${video.topicTitle}»? Відеофайл буде видалено, текстовий урок залишиться. Цю дію не можна скасувати.`)) return;
    await run(async () => {
      const result = await deleteVideoLessonAction(video.id);
      if (result.status === "error") throw new Error(result.message);
      setItems(previous => previous.filter(item => item.id !== video.id));
      setMessage(result.cleanupPending ? cleanupNotice : "Відео видалено. Текстовий урок залишився."); router.refresh();
    });
  }
  async function replace(selected: File) {
    const target = replacement.current; if (!target) return;
    if (!window.confirm(`Замінити відео до теми «${target.topicTitle}» файлом «${selected.name}»? Поточне відео залишатиметься доступним, доки новий файл не буде перевірено.`)) return;
    await run(async () => {
      const result = await uploadReplacementVideo(selected, target.topicId, target.id);
      setItems(previous => previous.map(item => item.id === target.id ? { ...item, sizeBytes: selected.size } : item));
      setMessage(result.cleanupPending ? cleanupNotice : "Відео замінено. Прив’язку до уроку збережено."); router.refresh();
    });
  }
  const subjects = [...new Map(items.map(video => [video.subjectId, video.subjectName])).entries()].sort((a, b) => a[1].localeCompare(b[1], "uk"));
  const normalized = query.toLocaleLowerCase("uk").trim();
  const filtered = items.filter(video => (!subject || video.subjectId === subject) && `${video.subjectName} ${video.topicTitle}`.toLocaleLowerCase("uk").includes(normalized));
  return <div>
    <div className="mb-5 grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold">Знайти відео<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Назва теми або предмета" className={`${parentInput} mt-2`} /></label><label className="text-sm font-semibold">Предмет або курс<select aria-label="Предмет або курс" value={subject} onChange={event => setSubject(event.target.value)} className={`${parentInput} mt-2`}><option value="">Усі предмети та курси</option>{subjects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label></div>
    <p role="status" className="mb-4 text-sm text-p-muted">Показано {filtered.length} з {items.length} · {(filtered.reduce((sum, video) => sum + video.sizeBytes, 0) / 1024 / 1024).toFixed(1)} МБ</p>
    {message && <p role="status" className="mb-4 rounded-xl border border-p-line bg-p-surface p-4 text-sm leading-relaxed">{message}</p>}
    {busy && <p role="status" className="mb-4 text-sm font-semibold text-p-primary">Виконуємо дію… Якщо завантажується новий файл, залиш цю сторінку відкритою.</p>}
    {filtered.length === 0 ? <div className="rounded-2xl border border-dashed border-p-line bg-p-surface p-8 text-center"><h2 className="text-lg font-bold">{items.length ? "За цим запитом відео немає" : "Тут з’являться відеоматеріали"}</h2><p className="mt-2 text-sm text-p-muted">{items.length ? "Зміни назву або обери інший предмет." : "Додай відео до теми уроку. Тут можна буде його переглянути, скачати, замінити або видалити."}</p></div> : <ul className="grid gap-4 xl:grid-cols-2">{filtered.map(video => <li key={video.id} className="min-w-0 rounded-2xl border border-p-line bg-p-surface p-5">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-p-primary">{video.subjectName}</p><h2 className="break-words text-lg font-bold leading-snug">{video.topicTitle}</h2>
      <p className="mt-2 text-sm text-p-muted">{(video.sizeBytes / 1024 / 1024).toFixed(1)} МБ · додано {new Date(video.createdAt).toLocaleDateString("uk-UA", { timeZone })}</p>
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => void open(video, false)} className={parentButton}>Переглянути</button><button type="button" disabled={busy} onClick={() => void open(video, true)} className="min-h-11 rounded-xl border border-p-line px-3 text-sm font-semibold disabled:opacity-60">Скачати</button><button type="button" disabled={busy} onClick={() => { replacement.current = video; file.current?.click(); }} className="min-h-11 rounded-xl border border-p-line px-3 text-sm font-semibold disabled:opacity-60">Замінити</button><button type="button" disabled={busy} onClick={() => void remove(video)} className="min-h-11 rounded-xl px-3 text-sm font-semibold text-p-danger disabled:opacity-60">Видалити</button></div>
    </li>)}</ul>}
    <input ref={file} aria-label="Новий відеофайл для заміни" type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden" disabled={busy} onChange={event => { const selected = event.target.files?.[0]; event.target.value = ""; if (selected) void replace(selected); }} />
    {preview && <dialog ref={dialog} onClose={() => setPreview(null)} onCancel={() => setPreview(null)} aria-label={`Відео: ${preview.title}`} className="m-auto w-[calc(100%_-_1.5rem)] max-w-4xl rounded-2xl border border-p-line bg-p-surface p-4 text-p-text backdrop:bg-black/70"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="min-w-0 break-words text-lg font-bold">{preview.title}</h2><button type="button" autoFocus onClick={() => { dialog.current?.close(); setPreview(null); }} className="min-h-11 shrink-0 rounded-xl border border-p-line px-3 text-sm font-bold">Закрити</button></div><video ref={media} controls playsInline preload="metadata" src={preview.url} className="max-h-[70dvh] w-full rounded-xl bg-black">Браузер не підтримує відео.</video></dialog>}
    <div className="mt-5"><Link href="/parent/materials?tab=video" className="inline-flex min-h-11 items-center text-sm font-semibold text-p-primary">Додати ще одне відео →</Link></div>
  </div>;
}
