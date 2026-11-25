"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { queueSchoolBatchAction, type SchoolBatchResult } from "@/app/actions/school-batch";
import { SCHOOL_BATCH_MAX } from "@/lib/school-day";
import { parentButton, parentInput } from "@/app/parent/ui";
import { addPicks, clearPicks, removePicks, setPickDeck, useSchoolPicks, type SchoolPick } from "./school-batch-store";

type PickInput = Omit<SchoolPick, "narratedDeck">;
const shortDate = (date: string) => new Intl.DateTimeFormat("uk-UA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

/** Checkbox on one lesson or homework card. */
export function SchoolPickBox({ pick }: { pick: PickInput }) {
  const picks = useSchoolPicks();
  const checked = picks.some(p => p.id === pick.id);
  const full = !checked && picks.length >= SCHOOL_BATCH_MAX;
  return <label className={`inline-flex min-h-11 items-center gap-2 rounded-xl border border-p-line px-3 text-sm font-bold ${full ? "opacity-50" : "cursor-pointer"}`}>
    <input type="checkbox" className="h-5 w-5" checked={checked} disabled={full} onChange={event => event.target.checked ? addPicks([pick]) : removePicks([pick.id])} />
    {pick.kind === "homework" ? "До пакета: допомога з ДЗ" : "До пакета: урок"}
  </label>;
}

/** «Вибрати весь день»: adds every lesson and homework of the shown day. */
export function SchoolPickDay({ picks }: { picks: PickInput[] }) {
  const selected = useSchoolPicks();
  const [note, setNote] = useState("");
  if (!picks.length) return null;
  const all = picks.every(p => selected.some(s => s.id === p.id));
  return <div className="flex flex-wrap items-center gap-2">
    <button type="button" className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-3 text-sm font-bold" onClick={() => {
      if (all) { removePicks(picks.map(p => p.id)); setNote(""); return; }
      const left = addPicks(picks); setNote(left ? `Не влізло ${left}: у пакеті максимум ${SCHOOL_BATCH_MAX}.` : "");
    }}>{all ? "Прибрати весь день з пакета" : "Додати весь день до пакета"}</button>
    {note && <span role="status" className="text-sm font-bold">{note}</span>}
  </div>;
}

/** Review the picked list (from any days) and queue it as one batch (D-136). */
export function SchoolBatchPanel({ defaultBudget = 3 }: { defaultBudget?: number }) {
  const picks = useSchoolPicks();
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState(defaultBudget);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [results, setResults] = useState<(SchoolBatchResult & { label: string })[]>([]);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const sorted = [...picks].sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  const budgetOk = Number.isFinite(budget) && budget >= 0.5 && budget <= 250;

  const launch = () => start(async () => {
    setError("");
    const id = batchId ?? crypto.randomUUID(); setBatchId(id);
    const response = await queueSchoolBatchAction({ batchId: id, budgetUsd: budget, items: sorted.map(p => ({ entryId: p.id, narratedDeck: p.narratedDeck })) });
    if (response.status === "error") { setError(response.message); return; }
    const labels = new Map(sorted.map(p => [p.id, `${shortDate(p.date)} · ${p.label}`]));
    setResults(response.results.map(r => ({ ...r, label: labels.get(r.entryId) ?? "Запис" })));
    removePicks(response.results.filter(r => r.status === "ok").map(r => r.entryId));
    if (response.results.every(r => r.status === "ok")) setBatchId(null);
  });

  if (!picks.length && !results.length) return null;
  return <section aria-label="Пакет підготовки" className="sticky bottom-3 z-10 rounded-2xl border border-p-line bg-p-surface p-4 shadow-lg">
    {results.length > 0 && <div role="status" className="mb-3 space-y-1 text-sm">
      <p className="font-bold">Поставлено в чергу: {results.filter(r => r.status === "ok").length} з {results.length}.</p>
      <ul className="space-y-1">{results.map(r => <li key={r.entryId} className="break-words">{r.status === "ok" ? <Link href={`/parent/studio/${r.projectId}`} className="font-bold text-p-primary">{r.label} →</Link> : <span>{r.label}: {r.message}</span>}</li>)}</ul>
      <button type="button" className="min-h-11 text-sm font-bold text-p-muted" onClick={() => setResults([])}>Сховати</button>
    </div>}
    {picks.length > 0 && <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-bold">У пакеті: {picks.length}</p>
        <button type="button" aria-expanded={open} className={parentButton} onClick={() => setOpen(!open)}>{open ? "Згорнути список" : "Перевірити список"}</button>
        <button type="button" className="min-h-11 text-sm font-bold text-p-muted" onClick={() => { clearPicks(); setBatchId(null); }}>Очистити</button>
      </div>
      {open && <div className="mt-4 space-y-4">
        <ol className="max-h-[50vh] space-y-2 overflow-y-auto">{sorted.map(p => <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-p-line p-3 text-sm">
          <span className="min-w-0 flex-1 break-words"><span className="font-bold">{shortDate(p.date)} · {p.kind === "homework" ? "ДЗ" : "Урок"} · {p.subject}</span>{p.label !== p.subject && <span className="block text-p-muted">{p.label}</span>}{!p.linked && <span className="block text-xs text-p-muted">Предмет не прив’язано: буде окремий курс у Майстерні.</span>}</span>
          <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={p.narratedDeck} onChange={event => setPickDeck(p.id, event.target.checked)} />Презентація з озвучкою</label>
          <button type="button" className="min-h-11 font-bold text-p-muted" aria-label={`Прибрати: ${p.subject}, ${shortDate(p.date)}`} onClick={() => removePicks([p.id])}>Прибрати</button>
        </li>)}</ol>
        <label className="block max-w-xs text-sm font-bold">Ліміт на один урок, $
          <input type="number" min={0.5} max={250} step={0.5} value={budget} onChange={event => setBudget(Number(event.target.value))} className={`${parentInput} mt-1`} />
        </label>
        <p className="text-sm text-p-muted">Кожен пункт стане окремим проєктом Майстерні: урок на 20 хвилин{picks.some(p => p.kind === "homework") ? ", для ДЗ пояснення й схоже розв’язане завдання без готових відповідей" : ""}. Загалом не більше ${(budget * picks.length).toFixed(2)}; зазвичай витрачається менше.</p>
        {error && <p role="alert" className="text-sm font-bold">{error}</p>}
        <button type="button" disabled={pending || !budgetOk} className={parentButton} onClick={launch}>{pending ? "Ставлю в чергу…" : `Поставити в чергу (${picks.length})`}</button>
      </div>}
    </>}
  </section>;
}
