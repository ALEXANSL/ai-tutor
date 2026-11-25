import { schoolToday, type SchoolEntryView } from "./eschool";

export interface SchoolDayLesson { lesson: SchoolEntryView; homework: SchoolEntryView[] }
export interface SchoolDay {
  date: string | null;
  /** Neighbouring days that have scheduled lessons, for back/forward navigation. */
  previous: string | null;
  next: string | null;
  lessons: SchoolDayLesson[];
  /** Homework due that day for a subject with no lesson in the schedule. */
  unscheduled: SchoolEntryView[];
  overdue: SchoolEntryView[];
}

const subjectKey = (view: SchoolEntryView) => view.entry.source.subjectExternalId ?? view.entry.source.subject.toLocaleLowerCase("uk");
const position = (view: SchoolEntryView) => view.entry.source.schedule?.number ?? 99;
export const isCalendarDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** One school day with its lessons, homework due that day and anything
 * already overdue. Without `requested` it is the first lesson day after
 * `today` (tomorrow, or Monday after a Friday), else the latest imported day.
 * Pure: no model calls. */
export function schoolDay(entries: readonly SchoolEntryView[], requested?: string | null, today = schoolToday()): SchoolDay {
  const live = entries.filter(view => !view.entry.source.cancelled);
  const homework = live.filter(view => view.entry.source.kind === "homework" && view.entry.status !== "done");
  const overdue = homework.filter(view => view.entry.source.dueDate !== null && view.entry.source.dueDate < today)
    .sort((a, b) => a.entry.source.dueDate!.localeCompare(b.entry.source.dueDate!));
  const dates = [...new Set(live.filter(view => view.entry.source.kind === "lesson").map(view => view.entry.source.lessonDate))].sort();
  // No future lessons imported yet: fall back to the latest known day.
  const date = isCalendarDate(requested) ? requested : dates.find(day => day > today) ?? dates.at(-1) ?? null;
  const previous = date ? dates.filter(day => day < date).at(-1) ?? null : null;
  const next = date ? dates.find(day => day > date) ?? null : null;
  if (!date) return { date, previous, next, lessons: [], unscheduled: [], overdue };
  const due = homework.filter(view => view.entry.source.dueDate === date);
  const lessons = live.filter(view => view.entry.source.kind === "lesson" && view.entry.source.lessonDate === date)
    .sort((a, b) => position(a) - position(b) || a.entry.source.subject.localeCompare(b.entry.source.subject, "uk"));
  const used = new Set<string>();
  const result = lessons.map(lesson => {
    const mine = due.filter(view => !used.has(view.id) && subjectKey(view) === subjectKey(lesson));
    mine.forEach(view => used.add(view.id));
    return { lesson, homework: mine };
  });
  return { date, previous, next, lessons: result, unscheduled: due.filter(view => !used.has(view.id)), overdue };
}

/** Prefilled Studio fields for a diary lesson or homework. Homework help keeps
 * the project rule (US-8.7, P-H): explain and model, never hand over answers. */
export function schoolStudioPrefill(source: SchoolEntryView["entry"]["source"]) {
  const topic = source.topic.trim();
  if (source.kind === "homework") {
    const task = source.text.trim() || topic;
    return {
      title: `ДЗ: ${source.subject}${topic ? ` — ${topic}` : ""}`.slice(0, 200),
      idea: [
        `Допоможи дитині зрозуміти й самостійно виконати домашнє завдання з предмета «${source.subject}»${source.dueDate ? ` (здати ${source.dueDate})` : ""}.`,
        "Поясни потрібне правило чи прийом простими словами, розбери на прикладі схоже завдання з іншими даними, дай коротку перевірку розуміння. Готових відповідей до самого завдання не давай.",
        `Завдання зі щоденника:\n${task}`,
      ].join("\n\n").slice(0, 20000),
    };
  }
  return {
    title: (topic || source.subject).slice(0, 200),
    idea: [
      `Підготуй урок до шкільної теми «${topic || source.subject}» з предмета «${source.subject}» на ${source.lessonDate}.`,
      "Поясни головне простими словами, з прикладами й короткою практикою, щоб дитина була готова до уроку.",
    ].join("\n\n"),
  };
}

/** D-136: one Studio request for a diary lesson or homework queued in a batch. */
export function schoolStudioRequest(entry: SchoolEntryView["entry"], options: { narratedDeck: boolean; budgetUsd: number; grade: number }) {
  const { title, idea } = schoolStudioPrefill(entry.source);
  return {
    mode: "course" as const, targetLanguage: /англій/iu.test(entry.source.subject) ? "en" as const : /німець/iu.test(entry.source.subject) ? "de" as const : null,
    title, idea, sourceText: "", subjectId: entry.subjectId, topicId: null, materialId: null, pageFrom: null, pageTo: null,
    age: 12, grade: options.grade, lessonCount: 1, minutes: 20, budgetUsd: options.budgetUsd, narratedDeck: options.narratedDeck,
  };
}
export const SCHOOL_BATCH_MAX = 20;
