import type { SchoolEntryView } from "./eschool";
export function schoolDateShift(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export function schoolWeekStart(date: string) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return schoolDateShift(date, -((day + 6) % 7)); }
export interface SchoolOccurrence { id: number; date: string; lesson: SchoolEntryView | null; homework: SchoolEntryView[]; }
export function schoolOccurrences(entries: SchoolEntryView[]): SchoolOccurrence[] {
  const groups = new Map<number, SchoolOccurrence>();
  for (const item of entries) { const id = item.entry.source.appointmentId; const group = groups.get(id) ?? { id, date: item.entry.source.lessonDate, lesson: null, homework: [] }; if (item.entry.source.kind === 'lesson') { group.lesson = item; group.date = item.entry.source.lessonDate; } else group.homework.push(item); groups.set(id, group); }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || ((a.lesson ?? a.homework[0])?.entry.source.schedule?.number ?? 999) - ((b.lesson ?? b.homework[0])?.entry.source.schedule?.number ?? 999) || ((a.lesson ?? a.homework[0])?.entry.source.schedule?.start ?? '').localeCompare((b.lesson ?? b.homework[0])?.entry.source.schedule?.start ?? '') || a.id - b.id);
}
