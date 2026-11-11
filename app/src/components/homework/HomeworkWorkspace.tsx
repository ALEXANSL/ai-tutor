"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { HomeworkFormat, HomeworkView } from "@/lib/homework";
import type { VoiceTarget } from "@/lib/voice";
import { LessonText } from "@/components/shared/LessonText";
interface Props { target: VoiceTarget; lessonTitle: string; backHref: string; pages: number[]; initial: HomeworkView[]; initialId?: string; }
export function HomeworkWorkspace({ target, lessonTitle, backHref, pages, initial, initialId }: Props) {
  const [works, setWorks] = useState(initial);
  const [current, setCurrent] = useState<HomeworkView | null>(initial.find(item => item.id === initialId) ?? null);
  const [question, setQuestion] = useState("");
  const [format, setFormat] = useState<HomeworkFormat>(current?.work.format ?? "chat");
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("");
  const [downloading, setDownloading] = useState(false);
  const activeId = useRef(current?.id ?? "");
  const draftId = useRef("");
  const request = useRef({ signature: "", id: "" });
  const locked = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function remember(item: HomeworkView) {
    setWorks(previous => [item, ...previous.filter(value => value.id !== item.id)]);
    if (activeId.current === item.id) setCurrent(previous => !previous || item.work.revision >= previous.work.revision ? item : previous);
  }
  async function refresh(id: string) {
    try {
      const response = await fetch(`/api/homework?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const result = await response.json() as HomeworkView;
      if (mounted.current && activeId.current === id) { remember(result); setConnection(""); }
    } catch { if (mounted.current && activeId.current === id) setConnection("Зв’язок перервано. Робота може готуватися далі. Онови стан перед повторним запитом."); }
  }
  useEffect(() => {
    if (current?.work.state !== "running") return;
    const id = current.id; const timer = window.setInterval(() => { void refresh(id); }, 2500);
    return () => window.clearInterval(timer);
    // Only identity/state controls this timer; revision updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.work.state]);
  function navigateWork(item: HomeworkView | null) {
    if (locked.current) return;
    activeId.current = item?.id ?? ""; draftId.current = ""; request.current = { signature: "", id: "" };
    setCurrent(item); setQuestion(""); setFiles([]); setSelectedPages([]); setError(""); setConnection(""); setFormat(item?.work.format ?? "chat");
    if (fileInput.current) fileInput.current.value = "";
    const url = new URL(window.location.href); if (item) url.searchParams.set("work", item.id); else url.searchParams.delete("work"); window.history.replaceState(null, "", url);
    if (item) void refresh(item.id);
  }
  async function send() {
    if (locked.current || !question.trim() || current?.work.state === "running") return;
    if (files.length > 3 || files.reduce((sum, file) => sum + file.size, 0) > 3 * 1024 * 1024) { setError("Додай до трьох файлів загальним розміром до 3 МБ."); return; }
    locked.current = true; setPending(true); setError("");
    const id = current?.id ?? (draftId.current ||= crypto.randomUUID()); activeId.current = id;
    const signature = JSON.stringify([id, question.trim(), format, selectedPages, files.map(file => [file.name, file.size, file.lastModified])]);
    if (request.current.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    const data = new FormData(); data.set("command", JSON.stringify({ id, requestId: request.current.id, revision: current?.work.revision ?? 0, question: question.trim(), format, pages: selectedPages, target }));
    files.forEach(file => data.append("files", file));
    try {
      const response = await fetch("/api/homework", { method: "POST", body: data }); const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Не вдалося надіслати запит.");
      if (!mounted.current) return;
      remember(body as HomeworkView); setQuestion(""); setFiles([]); if (fileInput.current) fileInput.current.value = "";
      const url = new URL(window.location.href); url.searchParams.set("work", id); window.history.replaceState(null, "", url);
    } catch (reason) { if (mounted.current) setError(`${reason instanceof Error ? reason.message : "Не вдалося підтвердити надсилання."} Запит залишився у полі. Повтор того самого запиту не створить дубль.`); }
    finally { locked.current = false; if (mounted.current) setPending(false); }
  }
  async function download(kind: "docx" | "pptx") {
    if (!current || downloading) return;
    setDownloading(true); setError("");
    try {
      const response = await fetch(`/api/homework/export?id=${current.id}&format=${kind}`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).message);
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url;
      const encoded = response.headers.get("Content-Disposition")?.split("filename*=UTF-8''")[1]; link.download = encoded ? decodeURIComponent(encoded) : `homework.${kind}`;
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не вдалося завантажити файл."); }
    finally { setDownloading(false); }
  }
  const busy = pending || current?.work.state === "running";
  const artifact = current?.work.result?.artifact;
  return <main className="mx-auto max-w-5xl space-y-6 px-4 pb-32 pt-20 md:px-6">
    <nav className="flex flex-wrap gap-2"><Link href={backHref} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-sm font-bold">← До уроку</Link><Link href="/today" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-sm font-bold">⌂ На головну</Link></nav>
    <header><p className="text-sm font-bold text-muted">{lessonTitle}</p><h1 className="mt-2 text-3xl font-extrabold">Моє домашнє завдання</h1><p className="mt-2 text-muted">Напиши, що задано. Репетитор допоможе розібратися, підготувати відповідь, документ або презентацію.</p></header>
    <section aria-label="Збережені роботи" className="rounded-2xl border border-line bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-extrabold">Роботи цього уроку</h2><button type="button" disabled={pending} onClick={() => navigateWork(null)} className="min-h-11 rounded-full border border-line px-4 font-bold disabled:opacity-50">＋ Нове завдання</button></div>{works.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{works.map(item => <button key={item.id} type="button" disabled={pending} aria-pressed={item.id === current?.id} onClick={() => navigateWork(item)} className={`min-h-12 min-w-0 rounded-xl border p-3 text-left text-sm ${item.id === current?.id ? "border-primary bg-surface-alt" : "border-line"}`}><span className="block break-words font-bold">{item.work.title}</span><span className="text-xs text-muted">{item.work.state === "running" ? "Готується…" : item.work.state === "failed" ? "Потрібна увага" : "Збережено"}</span></button>)}</div> : <p className="mt-3 text-sm text-muted">Тут з’являться твої роботи й діалоги до цього уроку.</p>}</section>
    {current && <section aria-label="Стан роботи" aria-live="polite" className="rounded-2xl border border-line bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="flex items-center gap-2 font-bold">{current.work.state === "running" && <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />}{current.work.state === "running" ? "Репетитор готує відповідь…" : current.work.state === "failed" ? "Запит не завершено" : "Відповідь готова"}</p><button type="button" onClick={() => { void refresh(current.id); }} className="min-h-11 rounded-xl border border-line px-3 text-sm font-bold">Оновити стан</button></div>{current.work.state === "running" && <p className="mt-2 text-sm text-muted">Роботу збережено. Можеш повернутися пізніше — відповідь з’явиться тут.</p>}{current.work.error && <p role="alert" className="mt-2 text-sm text-danger">{current.work.error}</p>}{connection && <p role="status" className="mt-2 text-sm text-danger">{connection}</p>}</section>}
    {current?.work.turns.length ? <section aria-label="Діалог про завдання" className="space-y-4">{current.work.turns.map(turn => <article key={turn.requestId} className="min-w-0 rounded-2xl border border-line bg-surface p-4 md:p-5"><p className="text-xs font-bold uppercase text-muted">Твій запит</p><p className="mt-2 whitespace-pre-wrap break-words">{turn.question}</p>{(turn.pages.length > 0 || turn.files.length > 0) && <p className="mt-2 break-words text-xs text-muted">{turn.pages.length ? `Сторінки: ${turn.pages.join(", ")}. ` : ""}{turn.files.join(", ")}</p>}{turn.answer && <div className="mt-4 border-t border-line pt-4"><p className="mb-2 text-xs font-bold uppercase text-muted">Репетитор</p><LessonText text={turn.answer} reflow /></div>}</article>)}</section> : null}
    {artifact && <section aria-label="Готова робота" className="min-w-0 rounded-2xl border-2 border-secondary bg-surface p-4 md:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="break-words text-xl font-extrabold">{artifact.title}</h2><div className="flex flex-wrap gap-2">{artifact.sections.length > 0 && <button disabled={downloading} onClick={() => { void download("docx"); }} className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-50">Завантажити Word</button>}{artifact.slides.length > 0 && <button disabled={downloading} onClick={() => { void download("pptx"); }} className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-50">Завантажити PowerPoint</button>}</div></div>{current?.work.state === "running" && <p className="mt-2 text-sm text-muted">Це попередня збережена версія. Нова відповідь ще готується.</p>}{artifact.subtitle && <p className="mt-2 break-words text-muted">{artifact.subtitle}</p>}<div className="mt-5 max-h-[65vh] space-y-5 overflow-y-auto overscroll-contain pr-2">{artifact.sections.map((section, index) => <div key={index}><h3 className="mb-2 text-lg font-extrabold">{section.heading}</h3>{section.paragraphs.map((text, i) => <p key={i} className="mb-3 whitespace-pre-wrap break-words leading-relaxed">{text}</p>)}</div>)}{artifact.slides.map((slide, index) => <div key={index} className="rounded-xl border border-line bg-surface-alt p-4"><p className="text-xs font-bold text-muted">Слайд {index + 1}</p><h3 className="mt-1 break-words text-lg font-extrabold">{slide.title}</h3><ul className="mt-3 list-disc space-y-2 pl-5">{slide.bullets.map((bullet, i) => <li key={i} className="break-words">{bullet}</li>)}</ul>{slide.notes && <details className="mt-3 text-sm"><summary className="cursor-pointer font-bold">Нотатки для виступу</summary><p className="mt-2 whitespace-pre-wrap break-words text-muted">{slide.notes}</p></details>}</div>)}</div>{artifact.studyTips.length > 0 && <details className="mt-5 rounded-xl border border-line p-3"><summary className="cursor-pointer font-bold">Як пояснити роботу своїми словами</summary><ul className="mt-3 list-disc space-y-2 pl-5">{artifact.studyTips.map((tip, index) => <li key={index}>{tip}</li>)}</ul></details>}</section>}
    <form onSubmit={event => { event.preventDefault(); void send(); }} className="min-w-0 space-y-4 rounded-2xl border border-line bg-surface p-4 md:p-6"><h2 className="text-xl font-extrabold">{current ? "Продовжити або змінити роботу" : "Нове завдання"}</h2><label className="block font-bold">Що потрібно зробити?<textarea value={question} onChange={event => setQuestion(event.target.value)} maxLength={20000} rows={6} disabled={busy} placeholder="Наприклад: сторінка 75, завдання 4 — підготуй презентацію на 7 слайдів. Або встав повний текст завдання й вимоги вчителя…" className="mt-2 w-full rounded-xl border-2 border-line bg-surface-alt p-3 font-normal" /></label><p className="text-xs text-muted">{question.length.toLocaleString("uk")}/20 000 · Тема уроку додається автоматично.</p>
    <label className="block text-sm font-bold">Формат результату<select value={format} onChange={event => setFormat(event.target.value as HomeworkFormat)} disabled={busy} className="mt-2 min-h-12 w-full rounded-xl border border-line bg-surface-alt px-3"><option value="chat">Відповідь у чаті</option><option value="docx">Документ Word (.docx)</option><option value="pptx">Презентація PowerPoint (.pptx)</option></select></label>
    {pages.length > 0 && <div><label className="block text-sm font-bold">Сторінка підручника — необов’язково<select aria-label="Додати сторінку підручника" value="" disabled={busy || selectedPages.length >= 2} onChange={event => { const page = Number(event.target.value); if (page && selectedPages.length < 2) setSelectedPages(previous => [...previous, page]); }} className="mt-2 min-h-12 w-full rounded-xl border border-line bg-surface-alt px-3"><option value="">Обери до двох сторінок</option>{pages.filter(page => !selectedPages.includes(page)).map(page => <option key={page} value={page}>Сторінка {page}</option>)}</select></label><div className="mt-2 flex flex-wrap gap-2">{selectedPages.map(page => <button key={page} type="button" disabled={busy} onClick={() => setSelectedPages(previous => previous.filter(value => value !== page))} className="min-h-11 rounded-full border border-secondary px-3 text-sm" aria-label={`Прибрати сторінку ${page}`}>Сторінка {page} ×</button>)}</div></div>}
    <label className="block text-sm font-bold">Фото, PDF або текст завдання — необов’язково<input ref={fileInput} type="file" multiple accept=".pdf,.txt,.png,.jpg,.jpeg,.webp" disabled={busy} onChange={event => setFiles([...(event.target.files ?? [])])} className="mt-2 block min-h-11 w-full min-w-0 rounded-xl border border-line p-2 text-xs" /><span className="mt-1 block text-xs font-normal text-muted">До трьох файлів, разом до 3 МБ; PDF до 12 сторінок. Вкладення використовуються для цього запиту. Щоб знову розібрати оригінал, додай файл повторно.</span></label>
    {format === "pptx" && <p className="text-xs text-muted">Редаговані текстові слайди з оформленням і нотатками для виступу. Зображення можна додати у PowerPoint після завантаження.</p>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}<button type="submit" disabled={busy || !question.trim()} className="min-h-12 w-full rounded-full bg-primary px-5 font-extrabold text-white disabled:opacity-50 sm:w-auto">{pending ? "Надсилаємо…" : current?.work.state === "running" ? "Готуємо відповідь…" : "Надіслати репетитору"}</button>
    </form>
  </main>;
}
