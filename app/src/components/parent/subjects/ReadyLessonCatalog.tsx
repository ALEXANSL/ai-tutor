"use client";
import Link from "next/link";
import { useState } from "react";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import type { SubjectTopicOption } from "@/server/subjects/queries";

export function ReadyLessonCatalog({ topics, canOpen }: { topics: SubjectTopicOption[]; canOpen: boolean }) {
  const [filter, setFilter] = useState("");
  const ready = topics.filter(topic => importedLessonHref(topic));
  const visible = ready.filter(topic => topic.title.toLocaleLowerCase("uk").includes(filter.trim().toLocaleLowerCase("uk")));
  return <div className="space-y-3">
    <p className="text-sm text-p-muted">Готових уроків: {ready.length}. Це матеріали курсу, доступні дитині.</p>
    {!canOpen && <p className="text-xs text-p-muted">Дитина відкриває ці уроки у своєму розділі «Предмети». На її пристрої їх можна відкрити також із режиму тата.</p>}
    <label className="flex flex-col gap-1 text-sm font-bold">Знайти урок<input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Назва або номер параграфа" className="min-h-11 rounded-xl border border-p-line bg-p-bg px-3 font-normal" /></label>
    <ul className="divide-y divide-p-line rounded-xl border border-p-line">{visible.map(topic => <li key={topic.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
      <div className="min-w-0"><p className="font-bold">{topic.title}</p>{topic.pageFrom !== null && <p className="text-xs text-p-muted">Сторінки: {topic.pageFrom}{topic.pageTo !== null && topic.pageTo !== topic.pageFrom ? `–${topic.pageTo}` : ""}</p>}{topic.hasVideoLesson && <span className="text-xs text-p-muted">Є додаткове відео</span>}</div>
      {canOpen && <Link href={importedLessonHref(topic)!} className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-3 font-bold text-white">Відкрити урок</Link>}
    </li>)}</ul>
    {!visible.length && <p role="status" className="text-sm text-p-muted">За цим запитом уроків не знайдено.</p>}
  </div>;
}
