"use client";
import { ReviseLessonsDialog } from "./ReviseLessonsDialog";
import Link from "next/link";
import { useState } from "react";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import type { SubjectTopicOption } from "@/server/subjects/queries";

export function ReadyLessonCatalog({ topics, canOpen, subjectId, extensions = [] }: { extensions?: { mode?: string; projectId: string; title: string; baseTopicId: string | null; lessons: { topicId: string }[] }[]; topics: SubjectTopicOption[]; canOpen: boolean; subjectId?: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [revising, setRevising] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const extensionTopics = new Set(extensions.filter(item => item.baseTopicId).flatMap(item => item.lessons.map(lesson => lesson.topicId)));
  const ready = topics.filter(topic => importedLessonHref(topic) && !extensionTopics.has(topic.id));
  const visible = ready.filter(topic => topic.title.toLocaleLowerCase("uk").includes(filter.trim().toLocaleLowerCase("uk")));
  return <div className="space-y-3">
    <p className="text-sm text-p-muted">Готових уроків: {ready.length}. Це матеріали курсу, доступні дитині.</p>
    {!canOpen && <p className="text-xs text-p-muted">Дитина відкриває ці уроки у своєму розділі «Предмети». На її пристрої їх можна відкрити також із режиму тата.</p>}
    <label className="flex flex-col gap-1 text-sm font-bold">Знайти урок<input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Назва або номер параграфа" className="min-h-11 rounded-xl border border-p-line bg-p-bg px-3 font-normal" /></label>
    {subjectId && <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={!selected.length} onClick={() => setRevising(selected)} className="min-h-11 rounded-xl border border-p-line px-3 text-sm font-bold disabled:opacity-50">Переробити вибрані ({selected.length}/6)</button>{selected.length > 0 && <button type="button" onClick={() => setSelected([])} className="min-h-11 text-sm underline">Скинути вибір</button>}</div>}
    {subjectId && revising && <ReviseLessonsDialog subjectId={subjectId} topics={ready.filter(topic => revising.includes(topic.id))} onClose={() => setRevising(null)} />}
    <ul className="divide-y divide-p-line rounded-xl border border-p-line">{visible.map(topic => <li key={topic.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
      <div className="min-w-0">{subjectId && <label className="mb-2 flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" aria-label={`Вибрати урок: ${topic.title}`} checked={selected.includes(topic.id)} disabled={!selected.includes(topic.id) && selected.length >= 6} onChange={event => setSelected(previous => event.target.checked ? [...previous, topic.id] : previous.filter(id => id !== topic.id))} />Для переробки</label>}<p className="font-bold">{topic.title}</p>{topic.pageFrom !== null && <p className="text-xs text-p-muted">Сторінки: {topic.pageFrom}{topic.pageTo !== null && topic.pageTo !== topic.pageFrom ? `–${topic.pageTo}` : ""}</p>}{topic.hasVideoLesson && <span className="text-xs text-p-muted">Є додаткове відео</span>}</div>
      <div className="flex flex-wrap gap-2">{subjectId && <button type="button" onClick={() => setRevising([topic.id])} className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-3 font-bold">Переробити урок</button>}{extensions.filter(item => item.mode === "revision" && item.baseTopicId === topic.id).map(item => <Link key={item.projectId} href={`/parent/studio/${item.projectId}`} className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-3 font-bold">Нова версія: {item.title}</Link>)}
        {extensions.filter(item => item.mode !== "revision" && item.baseTopicId === topic.id).map(item => <Link key={item.projectId} href={`/parent/studio/${item.projectId}`} className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-3 font-bold">Розширення: {item.title}</Link>)}
        {subjectId && <Link href={`/parent/studio/new?subject=${subjectId}&topic=${topic.id}`} className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-3 font-bold">Розширити з ШІ</Link>}
        {subjectId && <Link href={`/parent/subjects/${subjectId}/video-script?topic=${encodeURIComponent(topic.id)}`} className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-3 font-bold">Сценарій Pictory</Link>}
        {canOpen && <Link href={importedLessonHref(topic)!} className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-3 font-bold text-white">Відкрити урок</Link>}
      </div>
    </li>)}</ul>
    {!visible.length && <p role="status" className="text-sm text-p-muted">За цим запитом уроків не знайдено.</p>}
  </div>;
}
