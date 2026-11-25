import { schoolDue, schoolToday, type SchoolEntryView } from "@/lib/eschool";

export interface HomeworkItem { id: string; subject: string; text: string; due: string; href: string }
export interface HomeworkSummary { overdue: number; today: number; soon: number; open: HomeworkItem[] }

const ORDER: Record<string, number> = { "Термін минув": 0, "На сьогодні": 1, "Незабаром": 2, "Термін не вказано": 3 };

/** D-132: real homework counts for the parent overview and the child home (no fixed placeholder texts). */
export function homeworkSummary(entries: SchoolEntryView[], today = schoolToday(), limit = 3): HomeworkSummary {
  const open = entries
    .filter(({ entry }) => entry.source.kind === "homework" && !entry.source.cancelled)
    .map(({ id, entry }) => ({ id, entry, due: schoolDue(entry.source, entry.status, today) }))
    .filter((row): row is typeof row & { due: string } => row.due !== null)
    .sort((a, b) => ORDER[a.due]! - ORDER[b.due]! || (a.entry.source.dueDate ?? "9").localeCompare(b.entry.source.dueDate ?? "9"));
  const count = (due: string) => open.filter((row) => row.due === due).length;
  return {
    overdue: count("Термін минув"),
    today: count("На сьогодні"),
    soon: count("Незабаром") + count("Термін не вказано"),
    open: open.slice(0, limit).map(({ id, entry, due }) => ({
      id,
      subject: entry.source.subject,
      text: (entry.source.text || entry.source.topic).replace(/\s+/g, " ").trim().slice(0, 140),
      due,
      href: entry.workHref ?? entry.lessonHref ?? "/school",
    })),
  };
}
