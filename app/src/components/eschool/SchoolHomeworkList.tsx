"use client";
import { useState } from "react";
import { schoolToday, type SchoolEntryView } from "@/lib/eschool";
import { schoolDateShift, schoolWeekStart } from "@/lib/school-schedule";
import { SchoolCard } from "./SchoolCard";

type Scope = "week" | "day";
const at = (date: string) => new Date(`${date}T12:00:00Z`);
const capital = (text: string) => text.replace(/^./u, character => character.toLocaleUpperCase("uk"));
const weekdayFormat = new Intl.DateTimeFormat("uk-UA", { weekday: "long", timeZone: "Europe/Kiev" });
const dayMonthFormat = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", timeZone: "Europe/Kiev" });
const fullFormat = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Kiev" });
const shortFormat = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", timeZone: "Europe/Kiev" });

/** The day a record belongs to: homework by its due date (lesson date when
 * the teacher gave none), lessons by the lesson date. */
export const schoolEntryDay = (item: SchoolEntryView) => item.entry.source.dueDate ?? item.entry.source.lessonDate;

function weekLabel(start: string) {
  const end = schoolDateShift(start, 6);
  const sameMonth = at(start).getUTCMonth() === at(end).getUTCMonth();
  return `${sameMonth ? at(start).getUTCDate() : dayMonthFormat.format(at(start))} — ${fullFormat.format(at(end))}`;
}

function relative(date: string, today: string) {
  if (date === today) return "Сьогодні";
  if (date === schoolDateShift(today, 1)) return "Завтра";
  if (date === schoolDateShift(today, -1)) return "Учора";
  return null;
}

/** Homework of one week (default) or one day, with clear weekday + date
 * headings and arrows to move between weeks or days. Records are shown
 * whatever their status: teachers rarely set it in the diary, so a
 * done/not-done split would be stale. */
export function SchoolHomeworkList({ entries, parent = false, subjects = [], limited = false, initialScope = "week", initialDate }: { entries: SchoolEntryView[]; parent?: boolean; subjects?: { id: string; name: string }[]; limited?: boolean; initialScope?: Scope; initialDate?: string }) {
  const today = schoolToday();
  const [scope, setScope] = useState<Scope>(initialScope);
  const [date, setDate] = useState(initialDate ?? today);
  const [view, setView] = useState("homework");
  const [query, setQuery] = useState("");
  const border = parent ? "border-p-line" : "border-line"; const surface = parent ? "bg-p-surface" : "bg-surface"; const muted = parent ? "text-p-muted" : "text-muted";
  const active = parent ? "bg-p-primary text-white" : "bg-primary text-white";
  const button = `min-h-11 rounded-xl border ${border} px-3 text-sm font-bold`;

  const needle = query.trim().toLocaleLowerCase("uk");
  const visible = entries.filter(({ entry }) => view !== "homework" || entry.source.kind === "homework");
  const matches = (item: SchoolEntryView) => `${item.entry.source.subject} ${item.entry.source.topic} ${item.entry.source.text}`.toLocaleLowerCase("uk").includes(needle);
  const week = schoolWeekStart(date);
  const inWeek = (day: string) => day >= week && day <= schoolDateShift(week, 6);
  const period = visible.filter(item => (scope === "day" ? schoolEntryDay(item) === date : inWeek(schoolEntryDay(item))) && (!needle || matches(item)));

  // A week always lists Monday–Friday so the child sees free days too; weekend days only when something is due.
  const days = scope === "day" ? [date] : Array.from({ length: 7 }, (_, i) => schoolDateShift(week, i)).filter((day, i) => i < 5 || period.some(item => schoolEntryDay(item) === day));
  const byDay = (day: string) => period.filter(item => schoolEntryDay(item) === day).sort((a, b) => (a.entry.source.schedule?.number ?? 99) - (b.entry.source.schedule?.number ?? 99) || a.entry.source.subject.localeCompare(b.entry.source.subject, "uk"));
  const latest = visible.map(schoolEntryDay).sort().at(-1);

  function move(delta: number) { setDate(schoolDateShift(date, scope === "week" ? delta * 7 : delta)); }
  const isCurrent = scope === "week" ? week === schoolWeekStart(today) : date === today;
  const title = scope === "week" ? weekLabel(week) : `${capital(weekdayFormat.format(at(date)))}, ${fullFormat.format(at(date))}`;

  return <section className="space-y-4">
    <div className={`space-y-3 rounded-2xl border ${border} ${surface} p-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className={`inline-flex gap-1 rounded-xl border ${border} p-1`} role="group" aria-label="Показати за період">{([["week", "Тиждень"], ["day", "День"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)} className={`min-h-10 rounded-lg px-4 text-sm font-bold ${scope === value ? active : ""}`}>{label}</button>)}</div>
        <button type="button" onClick={() => setDate(today)} disabled={isCurrent} className={`${button} disabled:opacity-50`}>{scope === "week" ? "Цей тиждень" : "Сьогодні"}</button>
        <label className="ml-auto text-sm font-bold"><span className="sr-only">Показати записи</span><select aria-label="Показати записи" value={view} onChange={event => setView(event.target.value)} className={`min-h-11 rounded-xl border ${border} ${parent ? "bg-p-bg" : "bg-surface-alt"} px-3`}><option value="homework">Лише ДЗ</option><option value="all">Уроки й ДЗ</option></select></label>
      </div>
      <div className="grid grid-cols-[48px_1fr_48px] items-center gap-2">
        <button type="button" aria-label={scope === "week" ? "Попередній тиждень" : "Попередній день"} onClick={() => move(-1)} className={`${button} text-lg`}>‹</button>
        <h2 className="text-center text-lg font-extrabold sm:text-xl" aria-live="polite">{scope === "week" ? <>Тиждень: {title}</> : title}{relative(date, today) && scope === "day" && <span className={`ml-2 rounded-full px-2 py-0.5 align-middle text-xs ${active}`}>{relative(date, today)}</span>}</h2>
        <button type="button" aria-label={scope === "week" ? "Наступний тиждень" : "Наступний день"} onClick={() => move(1)} className={`${button} text-lg`}>›</button>
      </div>
      <label className="block text-sm"><span className="sr-only">Пошук у вибраному періоді</span><input type="search" aria-label="Пошук у вибраному періоді" value={query} onChange={event => setQuery(event.target.value)} placeholder={scope === "week" ? "Знайти предмет чи тему в цьому тижні" : "Знайти предмет чи тему в цьому дні"} className={`min-h-11 w-full rounded-xl border ${border} ${parent ? "bg-p-bg" : "bg-surface-alt"} px-3`} /></label>
    </div>
    {limited && <p className="text-sm">Показано 500 останніх записів.</p>}
    {!entries.length ? <p className={`rounded-2xl border ${border} p-5 text-sm ${muted}`}>Щоденник ще порожній. Тато може синхронізувати теми й ДЗ з Єдиної школи.</p> : <>
      <div className="space-y-6">{days.map(day => {
        const items = byDay(day); const label = relative(day, today);
        return <section key={day} aria-label={`${capital(weekdayFormat.format(at(day)))}, ${dayMonthFormat.format(at(day))}`} className="space-y-3">
          {scope === "week" && <header className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b ${border} pb-2 ${day === today ? parent ? "border-p-primary" : "border-primary" : ""}`}><h3 className="text-lg font-extrabold">{capital(weekdayFormat.format(at(day)))}</h3><time dateTime={day} className={`text-sm font-bold ${muted}`}>{dayMonthFormat.format(at(day))}</time>{label && <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${day === today ? active : `${surface} ${muted}`}`}>{label}</span>}<span className={`ml-auto text-xs ${muted}`}>{items.length ? `ДЗ: ${items.filter(item => item.entry.source.kind === "homework").length}` : ""}</span></header>}
          {scope === "day" && <time dateTime={day} className="sr-only">{fullFormat.format(at(day))}</time>}
          {items.length ? <div className="grid gap-4 lg:grid-cols-2">{items.map(item => <SchoolCard key={item.id} item={item} parent={parent} subjects={subjects} />)}</div> : <p className={`rounded-xl border border-dashed ${border} px-4 py-3 text-sm ${muted}`}>{needle ? "Нічого не знайдено." : view === "homework" ? "Домашніх завдань немає." : "Записів немає."}</p>}
        </section>;
      })}</div>
      {!period.length && latest && !(scope === "week" ? inWeek(latest) : latest === date) && <button type="button" onClick={() => setDate(latest)} className={button}>До останнього дня з записами: {shortFormat.format(at(latest))}</button>}
      <p className={`text-xs ${muted}`}>ДЗ показано в день, до якого його треба зробити. Якщо вчитель не вказав термін, ДЗ стоїть у день уроку.</p>
    </>}
  </section>;
}
