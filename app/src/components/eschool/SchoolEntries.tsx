"use client";
import { SchoolHomeworkList } from "./SchoolHomeworkList";
import { SchoolSchedule } from "./SchoolSchedule";
import { useState } from "react";
import { type SchoolEntryView } from "@/lib/eschool";
export function SchoolEntries(props: { entries: SchoolEntryView[]; parent?: boolean; subjects?: { id: string; name: string }[]; limited?: boolean; initialMode?: "week" | "list" }) {
  const [mode, setMode] = useState(props.initialMode ?? "week");
  return <section className="space-y-4"><div className={`inline-flex flex-wrap gap-1 rounded-xl border ${props.parent ? "border-p-line" : "border-line"} p-1`} aria-label="Вигляд щоденника">{([['week', 'Розклад тижня'], ['list', 'Домашні завдання']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`min-h-11 rounded-lg px-4 text-sm font-bold ${mode === value ? props.parent ? 'bg-p-primary text-white' : 'bg-primary text-white' : ''}`}>{label}</button>)}</div>{props.limited && mode === 'week' && <p className="text-sm">Показано 500 останніх записів.</p>}{mode === 'week' ? <SchoolSchedule entries={props.entries} parent={props.parent ?? false} subjects={props.subjects ?? []} /> : <SchoolHomeworkList {...props} />}</section>;
}
