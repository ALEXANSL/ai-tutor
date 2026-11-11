"use client";
import Link from "next/link";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { schoolDue, schoolStatusLabels, type SchoolEntryView, type SchoolStatus } from "@/lib/eschool";
import { setSchoolStatusAction, schoolLessonOptionsAction, mapSchoolEntryAction, launchSchoolHomeworkAction } from "@/app/actions/eschool";
export function SchoolEntries({ entries, parent = false, subjects = [], limited = false }: { entries: SchoolEntryView[]; parent?: boolean; subjects?: { id: string; name: string }[]; limited?: boolean }) {
  const [view, setView] = useState("homework"); const [query, setQuery] = useState(""); const [showDone, setShowDone] = useState(false);
  const filtered = entries.filter(({ entry }) => (view !== "homework" || entry.source.kind === "homework") && (showDone || entry.status !== "done" || entry.changed) && `${entry.source.subject} ${entry.source.topic} ${entry.source.text}`.toLocaleLowerCase("uk").includes(query.toLocaleLowerCase("uk"))).sort((a, b) => (a.entry.source.dueDate ?? a.entry.source.lessonDate).localeCompare(b.entry.source.dueDate ?? b.entry.source.lessonDate));
  const groups = new Map<string, SchoolEntryView[]>();
  for (const item of filtered) {
    const date = item.entry.source.dueDate ?? item.entry.source.lessonDate;
    const items = groups.get(date) ?? []; items.push(item); groups.set(date, items);
  }
  const dateFormat = new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Kiev" });
  return <section className="space-y-4"><div className="flex flex-wrap gap-3"><label className="min-w-0 basis-full text-sm font-bold sm:basis-0 sm:flex-1">Пошук<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Предмет, тема або завдання" className={`mt-1 min-h-12 w-full rounded-xl border px-3 ${parent ? "border-p-line bg-p-surface" : "border-line bg-surface"}`} /></label><label className="min-w-0 w-full max-w-full text-sm font-bold sm:w-auto">Показати<select aria-label="Показати записи" value={view} onChange={event => setView(event.target.value)} className={`mt-1 block min-h-12 w-full max-w-full rounded-xl border px-3 ${parent ? "border-p-line bg-p-surface" : "border-line bg-surface"}`}><option value="homework">Домашні завдання</option><option value="all">Уроки й домашні завдання</option></select></label></div><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={showDone} onChange={event => setShowDone(event.target.checked)} />Показати виконані</label>{limited && <p className="text-sm">Показано 500 останніх записів.</p>}{!filtered.length && <p className={`rounded-2xl border p-5 text-sm ${parent ? "border-p-line text-p-muted" : "border-line text-muted"}`}>{entries.length ? "За цим фільтром записів немає. Спробуй показати всі уроки або виконані завдання." : "Щоденник ще порожній. Тато може синхронізувати теми й ДЗ з Єдиної школи."}</p>}{filtered.length > 0 && <p className={`text-sm ${parent ? "text-p-muted" : "text-muted"}`}>ДЗ — за датою виконання, уроки — за датою уроку. Якщо термін ДЗ не вказаний, показуємо його в день уроку.</p>}<div className="space-y-8">{Array.from(groups, ([date, items]) => {
    const label = dateFormat.format(new Date(`${date}T12:00:00Z`)).replace(/^./u, character => character.toLocaleUpperCase("uk"));
    const homework = items.filter(item => item.entry.source.kind === "homework").length;
    return <section key={date} aria-label={label} className="space-y-3"><header className={`flex flex-wrap items-center justify-between gap-2 border-b pb-3 ${parent ? "border-p-line" : "border-line"}`}><h2 className="text-lg font-extrabold"><time dateTime={date}>{label}</time></h2><p className={`rounded-full px-3 py-1 text-xs font-bold ${parent ? "bg-p-surface text-p-muted" : "bg-surface text-muted"}`}>ДЗ: {homework}{view === "all" ? ` · Уроків: ${items.length - homework}` : ""}</p></header><div className="grid gap-4 lg:grid-cols-2">{items.map(item => <SchoolCard key={item.id} item={item} parent={parent} subjects={subjects} />)}</div></section>;
  })}</div></section>;
}
function SchoolCard({ item: { id, entry }, parent, subjects }: { item: SchoolEntryView; parent: boolean; subjects: { id: string; name: string }[] }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const [subject, setSubject] = useState(entry.subjectId ?? ""); const [topic, setTopic] = useState(entry.topicId ?? ""); const [lessons, setLessons] = useState<{ id: string; title: string }[]>([]);
  const source = entry.source; const due = schoolDue(source, entry.status);
  const input = parent ? "border-p-line bg-p-bg" : "border-line bg-surface-alt";
  const button = `inline-flex min-h-11 items-center justify-center rounded-xl border px-3 text-sm font-bold disabled:opacity-50 ${parent ? "border-p-line" : "border-line"}`;
  async function status(value: SchoolStatus) {
    if (lock.current) return; lock.current = true; setPending(true); setError("");
    try { const result = await setSchoolStatusAction({ id, revision: entry.revision, status: value }); if (result.status === "error") setError(result.message); else router.refresh(); }
    catch { setError("Не вдалося зберегти статус. Онови сторінку перед повтором."); }
    finally { lock.current = false; setPending(false); }
  }
  async function options(subjectId: string) {
    if (!subjectId) { setLessons([]); return; }
    const result = await schoolLessonOptionsAction(subjectId); if (result.status === "ok") setLessons(result.lessons); else setError(result.message);
  }
  async function mapping() {
    if (lock.current) return; lock.current = true; setPending(true); setError("");
    try { const result = await mapSchoolEntryAction({ id, revision: entry.revision, subjectId: subject || null, topicId: topic || null }); if (result.status === "error") setError(result.message); else router.refresh(); }
    catch { setError("Не вдалося прив’язати урок. Онови сторінку."); }
    finally { lock.current = false; setPending(false); }
  }
  async function launch() {
    if (lock.current) return; lock.current = true; setPending(true); setError("");
    try { const result = await launchSchoolHomeworkAction(id); if (result.status === "error") setError(result.message); else router.push(result.href); }
    catch { setError("Не вдалося відкрити роботу. Спробуй ще раз."); }
    finally { lock.current = false; setPending(false); }
  }
  return <article className={`min-w-0 space-y-3 rounded-2xl border p-5 ${parent ? "border-p-line bg-p-surface" : "border-line bg-surface"}`}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-bold">{source.subject} · {source.kind === "homework" ? "ДЗ" : "урок"}</p>{due && <span className={`rounded-full px-2 py-1 text-xs font-bold ${parent ? "bg-p-bg" : "bg-surface-alt"}`}>{due}</span>}</div><h3 className="break-words text-lg font-extrabold">{source.topic || "Тему не вказано"}</h3><p className="text-xs opacity-70">Урок: {source.lessonDate}{source.dueDate ? ` · Зробити до: ${source.dueDate}` : source.kind === "homework" ? " · Термін не вказано" : ""}</p>{source.cancelled && <p className="text-sm font-bold">Урок скасовано у щоденнику. Перевір, чи залишається ДЗ актуальним.</p>}{entry.changed && <p className="text-sm font-bold">Змінено в щоденнику — переглянь оновлену умову.</p>}{source.text && <div className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{source.text}</div>}{source.kind === "homework" && !source.text && <p className="text-sm">Опис не отримано. Перевір оригінальний щоденник або повтори синхронізацію.</p>}{source.attachments > 0 && <p className="text-xs opacity-70">Вкладень: {source.attachments}. Відкрий їх в оригінальному щоденнику.</p>}
    {source.kind === "homework" && <label className="block text-sm font-bold">Мій статус<select value={entry.status} disabled={pending} onChange={event => { void status(event.target.value as SchoolStatus); }} className={`mt-1 min-h-11 w-full rounded-xl border px-3 ${input}`}>{Object.entries(schoolStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    <div className="flex flex-wrap gap-2">{entry.workHref ? <Link href={entry.workHref} className={button}>Продовжити роботу</Link> : source.kind === "homework" && source.text && entry.lessonHref && <button disabled={pending} onClick={() => { void launch(); }} className={button}>Виконати з репетитором</button>}{entry.lessonHref ? <Link href={entry.lessonHref} className={button}>Відкрити урок</Link> : entry.subjectId && <Link href={`/subject/${entry.subjectId}`} className={button}>Відкрити предмет</Link>}<a href="https://diary.eschool-ua.com/" target="_blank" rel="noreferrer" className={button}>Оригінальний щоденник ↗</a></div>
    {parent && <details onToggle={event => { if (event.currentTarget.open && subject && !lessons.length) void options(subject); }} className="border-t border-p-line pt-3"><summary className="cursor-pointer text-sm font-bold">Прив’язати до предмета й уроку</summary><div className="mt-3 space-y-3"><label className="block text-sm">Предмет<select value={subject} disabled={pending} onChange={event => { setSubject(event.target.value); setTopic(""); void options(event.target.value); }} className={`mt-1 min-h-11 w-full rounded-xl border px-2 ${input}`}><option value="">Без прив’язки</option>{subjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="block text-sm">Урок<select value={topic} disabled={pending || !subject} onChange={event => setTopic(event.target.value)} className={`mt-1 min-h-11 w-full rounded-xl border px-2 ${input}`}><option value="">Обрати пізніше</option>{lessons.map(lesson => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}</select></label><button disabled={pending} onClick={() => { void mapping(); }} className={button}>Зберегти прив’язку</button></div></details>}
    {error && <p role="alert" className="text-sm">{error}</p>}{source.kind === "homework" && <p className="text-xs opacity-70">Готова відповідь або файл не означає, що завдання здано. Познач «Виконано», коли завершиш роботу.</p>}
  </article>;
}
