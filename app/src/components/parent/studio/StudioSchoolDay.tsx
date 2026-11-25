import Link from "next/link";
import { schoolStatusLabels, schoolToday, type SchoolEntryView } from "@/lib/eschool";
import type { SchoolDay } from "@/lib/school-day";
import { parentButton } from "@/app/parent/ui";
import { SchoolBatchPanel, SchoolPickBox, SchoolPickDay } from "./SchoolBatch";

const chip = "inline-flex min-h-11 items-center rounded-xl border border-p-line px-3 text-sm font-bold";
export const schoolPick = ({ id, entry: { source, subjectId } }: SchoolEntryView) => ({
  id, kind: source.kind, subject: source.subject, date: (source.kind === "homework" ? source.dueDate : null) ?? source.lessonDate, linked: !!subjectId,
  label: (source.kind === "homework" ? source.text.trim() || source.topic.trim() : source.topic.trim()).slice(0, 120) || source.subject,
});
const dateLabel = (date: string) => new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

function Homework({ view }: { view: SchoolEntryView }) {
  const { source, status } = view.entry;
  return <li className="space-y-2 rounded-xl border border-p-line p-3">
    <p className="text-xs font-semibold text-p-muted">Домашнє завдання · {schoolStatusLabels[status]}{source.dueDate ? ` · здати ${source.dueDate}` : ""}{source.attachments ? ` · вкладень у щоденнику: ${source.attachments}` : ""}</p>
    <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm">{source.text || source.topic || "Текст завдання не вказано"}</p>
    <div className="flex flex-wrap gap-2"><Link href={`/parent/studio/new?school=${view.id}`} className={parentButton}>Допомога з ДЗ</Link><SchoolPickBox pick={schoolPick(view)} />{view.entry.workHref && <Link href={view.entry.workHref} className={chip}>Робота дитини</Link>}</div>
  </li>;
}

/** «Школа на завтра»: read-only view of imported diary data; every button only
 * opens a prefilled form, so nothing here calls a model or spends budget. */
export function StudioSchoolDay({ day, deckTopics, connected, today = schoolToday() }: { day: SchoolDay; deckTopics: ReadonlySet<string>; connected: boolean; today?: string }) {
  if (!connected) return <section className="rounded-2xl border border-dashed border-p-line bg-p-surface p-7"><h2 className="text-xl font-bold">Розклад ще не імпортовано</h2><p className="mt-3 text-sm text-p-muted">Імпортуй уроки й ДЗ з «Єдиної школи», і тут з’явиться наступний навчальний день.</p><Link href="/parent/school" className={`${parentButton} mt-4`}>Відкрити «Школу»</Link></section>;
  return <div className="space-y-6">
    {day.overdue.length > 0 && <section aria-label="Прострочені ДЗ" className="rounded-2xl border border-p-line bg-p-surface p-4"><h2 className="mb-3 text-lg font-bold">Прострочені ДЗ ({day.overdue.length})</h2><ul className="space-y-2">{day.overdue.map(view => <li key={view.id} className="flex flex-wrap items-center gap-3 text-sm"><span className="font-bold">{view.entry.source.subject}</span><span className="text-p-muted">термін {view.entry.source.dueDate}</span><Link href={`/parent/studio/new?school=${view.id}`} className="inline-flex min-h-11 items-center font-bold text-p-primary">Допомога з ДЗ →</Link><SchoolPickBox pick={schoolPick(view)} /></li>)}</ul></section>}
    {!day.date ? <section className="rounded-2xl border border-dashed border-p-line bg-p-surface p-7"><h2 className="text-xl font-bold">У розкладі ще немає уроків</h2><p className="mt-3 text-sm text-p-muted">Онови імпорт у «Школі», щоб побачити розклад.</p><Link href="/parent/school" className={`${parentButton} mt-4`}>Оновити в «Школі»</Link></section>
      : <section aria-label="Навчальний день">
        <nav aria-label="Дні розкладу" className="mb-3 flex flex-wrap items-center gap-2">{day.previous && <Link href={`/parent/studio?tab=school&date=${day.previous}`} className={chip}>← {dateLabel(day.previous)}</Link>}<Link href="/parent/studio?tab=school" className={chip}>Наступний день</Link>{day.next && <Link href={`/parent/studio?tab=school&date=${day.next}`} className={chip}>{dateLabel(day.next)} →</Link>}</nav>
        <h2 className="mb-1 text-xl font-bold first-letter:uppercase">{dateLabel(day.date)}</h2>{day.date <= today && <p className="mb-2 text-sm font-bold">{day.date === today ? "Це сьогоднішній день." : "Це минулий день."}{!day.next && " Наступних днів у розкладі ще немає: онови імпорт у «Школі»."}</p>}<p className="mb-4 text-sm text-p-muted">Кнопки відкривають форму Майстерні з уже заповненим предметом, темою й текстом завдання. Щоб підготувати кілька уроків за різні дні, познач їх «До пакета», перейди до інших днів і запусти весь список одразу.</p>
        <div className="mb-4"><SchoolPickDay picks={[...day.lessons.flatMap(({ lesson, homework }) => [...(lesson.entry.lessonHref ? [] : [lesson]), ...homework]), ...day.unscheduled].map(schoolPick)} /></div>
        {!day.lessons.length && <p className="rounded-2xl border border-dashed border-p-line p-5 text-sm text-p-muted">У цей день уроків у розкладі немає.</p>}<ol className="space-y-4">{day.lessons.map(({ lesson, homework }) => {
          const { source, lessonHref, topicId, subjectId } = lesson.entry;
          const hasDeck = !!topicId && deckTopics.has(topicId);
          return <li key={lesson.id} className="min-w-0 space-y-3 rounded-2xl border border-p-line bg-p-surface p-5">
            <p className="text-xs font-semibold text-p-muted">{[source.schedule?.number ? `${source.schedule.number} урок` : null, source.schedule?.start, source.schedule?.room ? `каб. ${source.schedule.room}` : null].filter(Boolean).join(" · ") || "Урок"}</p>
            <h3 className="break-words text-lg font-bold">{source.subject}</h3>
            {source.topic && <p className="break-words text-sm">{source.topic}</p>}
            <p className="flex flex-wrap gap-2 text-xs font-bold">{lessonHref ? <span className="rounded-lg bg-[color-mix(in_srgb,var(--p-primary)_12%,transparent)] px-2 py-1 text-p-primary">Є урок</span> : <span className="rounded-lg border border-p-line px-2 py-1 text-p-muted">Немає матеріалів</span>}{hasDeck && <span className="rounded-lg bg-[color-mix(in_srgb,var(--p-primary)_12%,transparent)] px-2 py-1 text-p-primary">Є презентація</span>}</p>
            <div className="flex flex-wrap gap-2">{lessonHref ? <Link href={lessonHref} className={chip}>Відкрити урок</Link> : <Link href={`/parent/studio/new?school=${lesson.id}`} className={parentButton}>Підготувати урок</Link>}{lessonHref && !hasDeck && <Link href="/parent/studio/presentations" className={chip}>Додати презентацію</Link>}{subjectId && <Link href={`/parent/subjects/${subjectId}`} className={chip}>Матеріали предмета</Link>}{!lessonHref && <SchoolPickBox pick={schoolPick(lesson)} />}</div>
            {homework.length > 0 && <ul className="space-y-2">{homework.map(view => <Homework key={view.id} view={view} />)}</ul>}
          </li>;
        })}</ol>
        {day.unscheduled.length > 0 && <section aria-label="Інші ДЗ на цей день" className="mt-6"><h3 className="mb-2 text-lg font-bold">Інші ДЗ на цей день</h3><ul className="space-y-2">{day.unscheduled.map(view => <Homework key={view.id} view={view} />)}</ul></section>}
      </section>}
    <SchoolBatchPanel />
    <p className="text-sm text-p-muted">Статус ДЗ і прив’язку до уроків змінюй у розділі <Link href="/parent/school" className="font-bold text-p-primary">«Школа»</Link>.</p>
  </div>;
}
