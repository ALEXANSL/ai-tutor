"use client";

import Link from "next/link";
import { useState } from "react";
import { searchLiteratureV2Action } from "@/app/actions/literature-course-v2";
import { OpenTextbookPageButton } from "@/components/shared/BookPageModal";
import { MathText } from "@/components/shared/MathText";
import type { LiteratureV2SearchLessonHit, LiteratureV2SearchResult, LiteratureV2SearchTextbook } from "@/server/lessons/literatureV2Search";

const DIGITS_ONLY = /^\d{1,4}$/;

/**
 * PO feedback 2026-10-08: "де пошук по підручнику" — literature-v2's own
 * version of `MathCourseV2Search.tsx` (S35), same single smart box: a bare
 * number searches both textbook page and task number at once, free text
 * searches lesson titles.
 */
export function LiteratureV2Search({ subjectId, textbook }: { subjectId: string; textbook: LiteratureV2SearchTextbook | null }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "ok"; result: LiteratureV2SearchResult } | { status: "error"; message: string }>({
    status: "idle",
  });

  async function search() {
    const q = query.trim();
    if (!q) return;
    setState({ status: "loading" });
    const isNumber = DIGITS_ONLY.test(q);
    const res = await searchLiteratureV2Action(isNumber ? { subjectId, page: q, taskLabel: q } : { subjectId, topicQuery: q });
    if (res.status === "ok") setState({ status: "ok", result: res.result });
    else setState({ status: "error", message: res.message });
  }

  const lessons: LiteratureV2SearchLessonHit[] =
    state.status === "ok"
      ? [...state.result.lessonsByPage, ...state.result.lessonsByTopic].filter((l, i, arr) => arr.findIndex((o) => o.id === l.id) === i)
      : [];

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Тема, номер завдання або сторінка підручника…"
          className="min-h-11 flex-1 rounded-xl border-2 border-line bg-bg px-3 text-sm outline-none focus:border-focus"
        />
        <button
          type="button"
          onClick={() => void search()}
          disabled={state.status === "loading" || !query.trim()}
          className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-60"
        >
          {state.status === "loading" ? "Шукаю…" : "🔎 Знайти"}
        </button>
        {textbook && (
          <OpenTextbookPageButton materialId={textbook.materialId} title={textbook.title} pageCount={textbook.pageCount} page={1} label="📖 Відкрити підручник" />
        )}
      </div>

      {state.status === "error" && (
        <p role="alert" className="mt-2 text-sm font-bold text-danger">
          {state.message}
        </p>
      )}

      {state.status === "ok" && (
        <div className="mt-3 flex flex-col gap-2">
          {lessons.length === 0 && state.result.tasksByLabel.length === 0 && <p className="text-sm text-muted">Нічого не знайдено.</p>}
          {lessons.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
              <Link href={`/literature-course-v2/${l.id}`} className="font-semibold">
                📘 {l.title}
                {l.printedPageFrom != null && (
                  <span className="font-normal text-muted"> · с. {l.printedPageFrom}{l.printedPageTo && l.printedPageTo !== l.printedPageFrom ? `–${l.printedPageTo}` : ""}</span>
                )}
              </Link>
              {textbook && l.printedPageFrom != null && (
                <OpenTextbookPageButton materialId={textbook.materialId} title={textbook.title} pageCount={textbook.pageCount} page={l.printedPageFrom} />
              )}
            </div>
          ))}
          {state.result.tasksByLabel.map((t) => (
            <div key={t.taskId} className="rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/literature-course-v2/${t.lessonId}`} className="font-semibold">
                  📘 № {t.originalLabel} · {t.lessonTitle}
                </Link>
                {textbook && t.printedPage != null && (
                  <OpenTextbookPageButton materialId={textbook.materialId} title={textbook.title} pageCount={textbook.pageCount} page={t.printedPage} />
                )}
              </div>
              <p className="mt-1 text-muted">
                <MathText text={t.promptDisplay.slice(0, 160)} />
                {t.promptDisplay.length > 160 ? "…" : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
