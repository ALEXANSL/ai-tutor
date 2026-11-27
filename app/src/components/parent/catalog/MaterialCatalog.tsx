"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { setCatalogArchivedAction } from "@/app/actions/catalog";
import { parentInput } from "@/app/parent/ui";
import {
  CATALOG_KINDS, CATALOG_PERIODS, CATALOG_SORTS, CATALOG_STATUSES, catalogQueryString, filterCatalog, kindCounts, kindIcons, kindLabels, kindPlural,
  periodLabels, sortLabels, statusLabels, type CatalogFilters, type CatalogItem, type CatalogStatus,
} from "@/lib/catalog";

const PAGE = 24;
const statusTone: Record<CatalogStatus, string> = {
  child: "text-p-success border-p-success", review: "text-p-primary border-p-primary", preparing: "text-p-muted border-p-line",
  attention: "text-p-danger border-p-danger", ready: "text-p-success border-p-success", off: "text-p-muted border-p-line",
};
const chip = "inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm font-bold";
const hue = (text: string) => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return Math.round((h % 1000) * 137.508) % 360; };

export function MaterialCatalog({ items: initialItems, initialFilters, timeZone }: { items: CatalogItem[]; initialFilters: CatalogFilters; timeZone: string }) {
  const [items, setItems] = useState(initialItems);
  const [previous, setPrevious] = useState(initialItems);
  if (previous !== initialItems) { setPrevious(initialItems); setItems(initialItems); }
  const [filters, setFilters] = useState(initialFilters);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; undo?: { keys: string[]; archived: boolean } } | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);

  // Filters live in the URL (shareable, survive reload) without a server round trip.
  useEffect(() => { const next = `${window.location.pathname}${catalogQueryString(filters)}`; if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next); }, [filters]);

  const subjects = useMemo(() => [...new Map(items.filter(item => item.subjectId && item.subjectName).map(item => [item.subjectId!, item.subjectName!])).entries()].sort((a, b) => a[1].localeCompare(b[1], "uk")), [items]);
  const grades = useMemo(() => [...new Set(items.map(item => item.grade).filter((grade): grade is number => grade !== null))].sort((a, b) => a - b), [items]);
  const visible = useMemo(() => filterCatalog(items, filters), [items, filters]);
  const counts = useMemo(() => kindCounts(items, filters), [items, filters]);
  const viewTotal = items.filter(item => item.archived === filters.archived).length;
  const archivedTotal = items.filter(item => item.archived).length;
  const shown = visible.slice(0, limit);

  const update = (patch: Partial<CatalogFilters>) => { setFilters(current => ({ ...current, ...patch })); setLimit(PAGE); };
  const subjectName = (id: string) => subjects.find(([key]) => key === id)?.[1] ?? "Предмет";
  const active: { label: string; clear: Partial<CatalogFilters> }[] = [
    ...(filters.q.trim() ? [{ label: `Пошук: «${filters.q.trim()}»`, clear: { q: "" } }] : []),
    ...(filters.kind ? [{ label: kindPlural[filters.kind], clear: { kind: "" as const } }] : []),
    ...(filters.subject ? [{ label: subjectName(filters.subject), clear: { subject: "" } }] : []),
    ...(filters.status ? [{ label: statusLabels[filters.status], clear: { status: "" as const } }] : []),
    ...(filters.grade ? [{ label: `${filters.grade} клас`, clear: { grade: "" } }] : []),
    ...(filters.period ? [{ label: periodLabels[filters.period], clear: { period: "" as const } }] : []),
  ];
  const resetAll = () => update({ q: "", kind: "", subject: "", status: "", grade: "", period: "" });

  async function archive(keys: string[], archived: boolean, withUndo = true) {
    if (busy || !keys.length) return;
    setBusy(true); setNotice(null);
    const result = await setCatalogArchivedAction(keys, archived).catch(() => ({ status: "error" as const, message: "Немає зв’язку із сервером. Спробуй ще раз." }));
    setBusy(false);
    if (result.status === "error") { setNotice({ text: result.message }); return; }
    const set = new Set(keys);
    setItems(current => current.map(item => set.has(item.key) ? { ...item, archived } : item));
    setSelected(current => current.filter(key => !set.has(key)));
    setNotice({ text: archived ? `Перенесено в архів: ${keys.length}. Нічого не видалено, дитина бачить усе як раніше.` : `Повернуто з архіву: ${keys.length}.`, undo: withUndo ? { keys, archived: !archived } : undefined });
    toolbar.current?.focus();
  }

  const allShownSelected = shown.length > 0 && shown.every(item => selected.includes(item.key));
  const someShownSelected = shown.some(item => selected.includes(item.key));

  return <div className="space-y-4">
    <div ref={toolbar} tabIndex={-1} className="space-y-3 outline-none">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-72 text-sm font-semibold">Пошук<input type="search" value={filters.q} onChange={event => update({ q: event.target.value })} placeholder="Тема, параграф, предмет або книга" className={`${parentInput} mt-1.5`} /></label>
        <div role="group" aria-label="Що показати" className="flex rounded-xl border border-p-line p-1">
          {[false, true].map(archived => <button key={String(archived)} type="button" aria-pressed={filters.archived === archived} onClick={() => { update({ archived }); setSelected([]); }} className={`min-h-9 rounded-lg px-3 text-sm font-bold ${filters.archived === archived ? "bg-p-primary text-white" : "text-p-muted"}`}>{archived ? `Архів (${archivedTotal})` : "Активні"}</button>)}
        </div>
      </div>
      <div role="group" aria-label="Тип матеріалу" className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={!filters.kind} onClick={() => update({ kind: "" })} className={`${chip} ${!filters.kind ? "border-p-primary text-p-primary" : "border-p-line text-p-muted"}`}>Усі <span className="font-normal">{Object.values(counts).reduce((a, b) => a + b, 0)}</span></button>
        {CATALOG_KINDS.map(kind => <button key={kind} type="button" aria-pressed={filters.kind === kind} onClick={() => update({ kind: filters.kind === kind ? "" : kind })} className={`${chip} ${filters.kind === kind ? "border-p-primary text-p-primary" : "border-p-line text-p-muted"}`}><span aria-hidden>{kindIcons[kind]}</span>{kindPlural[kind]} <span className="font-normal">{counts[kind]}</span></button>)}
      </div>
      <details className="rounded-2xl border border-p-line bg-p-surface" open={!!(filters.subject || filters.status || filters.grade || filters.period || filters.sort !== "new")}>
        <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-bold">Фільтри й сортування</summary>
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-sm font-semibold">Предмет або курс<select value={filters.subject} onChange={event => update({ subject: event.target.value })} className={`${parentInput} mt-1.5`}><option value="">Усі</option>{subjects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="text-sm font-semibold">Стан<select value={filters.status} onChange={event => update({ status: event.target.value as CatalogFilters["status"] })} className={`${parentInput} mt-1.5`}><option value="">Будь-який</option>{CATALOG_STATUSES.map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label>
          {grades.length > 1 && <label className="text-sm font-semibold">Клас<select value={filters.grade} onChange={event => update({ grade: event.target.value })} className={`${parentInput} mt-1.5`}><option value="">Усі</option>{grades.map(grade => <option key={grade} value={String(grade)}>{grade} клас</option>)}</select></label>}
          <label className="text-sm font-semibold">Коли додано<select value={filters.period} onChange={event => update({ period: event.target.value as CatalogFilters["period"] })} className={`${parentInput} mt-1.5`}><option value="">За весь час</option>{CATALOG_PERIODS.map(period => <option key={period} value={period}>{periodLabels[period]}</option>)}</select></label>
          <label className="text-sm font-semibold">Сортування<select value={filters.sort} onChange={event => update({ sort: event.target.value as CatalogFilters["sort"] })} className={`${parentInput} mt-1.5`}>{CATALOG_SORTS.map(sort => <option key={sort} value={sort}>{sortLabels[sort]}</option>)}</select></label>
        </div>
      </details>
      {active.length > 0 && <div className="flex flex-wrap items-center gap-2">{active.map(filter => <button key={filter.label} type="button" onClick={() => update(filter.clear)} aria-label={`Прибрати фільтр: ${filter.label}`} className="inline-flex min-h-9 items-center gap-1 rounded-full border border-p-line bg-p-surface px-3 text-sm">{filter.label} <span aria-hidden>✕</span></button>)}<button type="button" onClick={resetAll} className="min-h-9 px-2 text-sm font-bold text-p-primary underline">Скинути все</button></div>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-p-muted">Показано {shown.length} з {visible.length}{visible.length !== viewTotal ? ` (усього ${filters.archived ? "в архіві" : "активних"}: ${viewTotal})` : ""} · {sortLabels[filters.sort].toLocaleLowerCase("uk")}</p>
        {shown.length > 0 && <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={allShownSelected} ref={element => { if (element) element.indeterminate = !allShownSelected && someShownSelected; }} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, ...shown.map(item => item.key)])] : current.filter(key => !shown.some(item => item.key === key)))} />Вибрати показані ({shown.length})</label>}
      </div>
    </div>

    {selected.length > 0 && <div className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-p-primary bg-p-surface p-3 shadow-sm">
      <span className="text-sm font-bold">Вибрано: {selected.length}</span>
      <button type="button" disabled={busy} onClick={() => void archive(selected, !filters.archived)} className="min-h-11 rounded-xl bg-p-primary px-4 text-sm font-bold text-white disabled:opacity-60">{filters.archived ? "Повернути з архіву" : "Перенести в архів"}</button>
      <button type="button" onClick={() => setSelected([])} className="min-h-11 px-2 text-sm underline">Скасувати вибір</button>
    </div>}
    {notice && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-p-line bg-p-surface p-3 text-sm">{notice.text}{notice.undo && <button type="button" disabled={busy} onClick={() => void archive(notice.undo!.keys, notice.undo!.archived, false)} className="min-h-9 font-bold text-p-primary underline">Скасувати</button>}</div>}

    {visible.length === 0 ? <div className="rounded-2xl border border-dashed border-p-line bg-p-surface p-8 text-center">
      {viewTotal === 0 ? (filters.archived
        ? <><h2 className="text-lg font-bold">Архів порожній</h2><p className="mt-2 text-sm text-p-muted">Перенеси сюди старі або непотрібні матеріали, щоб вони не заважали. Вони не видаляються, і їх завжди можна повернути.</p></>
        : <><h2 className="text-lg font-bold">Тут з’являться всі матеріали</h2><p className="mt-2 text-sm text-p-muted">Уроки, презентації з озвучкою, відео, аудіо й книги збираються тут автоматично.</p><Link href="/parent/studio/new" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-bold text-white">Підготувати урок із ШІ</Link></>)
        : <><h2 className="text-lg font-bold">Нічого не знайдено</h2><p className="mt-2 text-sm text-p-muted">{active.length ? `За фільтрами «${active.map(filter => filter.label).join("», «")}» матеріалів немає.` : "Немає матеріалів у цьому поданні."}</p>{active.length > 0 && <button type="button" onClick={resetAll} className="mt-4 min-h-11 rounded-xl border border-p-line px-4 text-sm font-bold">Скинути фільтри</button>}</>}
    </div> : <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{shown.map(item => {
      const checked = selected.includes(item.key);
      return <li key={item.key} className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-p-surface ${checked ? "border-p-primary" : "border-p-line"}`}>
        <Link href={item.href} className={`relative block overflow-hidden ${item.cover ? "aspect-[16/9]" : "h-20 sm:h-auto sm:aspect-[16/9]"}`} tabIndex={-1} aria-hidden>
          {item.cover
            // eslint-disable-next-line @next/next/no-img-element -- signed storage URLs, not optimisable by next/image
            ? <img src={item.cover} alt="" loading="lazy" className="h-full w-full object-cover" />
            : <div className="flex h-full w-full items-center justify-center text-3xl sm:text-5xl" style={{ background: `hsl(${hue(item.subjectId ?? item.kind)} 70% 50% / 0.16)` }}>{kindIcons[item.kind]}</div>}
          <span className="absolute left-2 top-2 rounded-lg bg-black/65 px-2 py-1 text-xs font-bold text-white">{kindIcons[item.kind]} {kindLabels[item.kind]}</span>
        </Link>
        <div className="flex flex-1 flex-col p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-p-primary">{item.subjectName ?? "Без предмета"}{item.grade ? ` · ${item.grade} клас` : ""}</p>
          <h2 className="mt-1 break-words text-base font-bold leading-snug"><Link href={item.href} className="hover:underline">{item.title}</Link></h2>
          {item.topicTitle && <p className="mt-1 break-words text-sm text-p-muted">{item.topicTitle}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className={`rounded-full border px-2 py-0.5 font-bold ${statusTone[item.status]}`}>{statusLabels[item.status]}</span><span className="text-p-muted">додано {new Date(item.createdAt).toLocaleDateString("uk-UA", { timeZone, day: "numeric", month: "short", year: "numeric" })}</span>{item.notes.map(note => <span key={note} className="text-p-muted">· {note}</span>)}</div>
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
            <Link href={item.href} className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-3 text-sm font-bold text-white">Відкрити</Link>
            <button type="button" disabled={busy} onClick={() => void archive([item.key], !item.archived)} className="min-h-11 rounded-xl border border-p-line px-3 text-sm font-semibold disabled:opacity-60">{item.archived ? "Повернути" : "В архів"}</button>
            <label className="ml-auto flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" aria-label={`Вибрати: ${item.title}`} checked={checked} onChange={event => setSelected(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />Вибрати</label>
          </div>
        </div>
      </li>;
    })}</ul>}
    {visible.length > shown.length && <div className="text-center"><button type="button" onClick={() => setLimit(value => value + PAGE)} className="min-h-11 rounded-xl border border-p-line px-5 text-sm font-bold">Показати ще {Math.min(PAGE, visible.length - shown.length)} з {visible.length - shown.length}</button></div>}
  </div>;
}
