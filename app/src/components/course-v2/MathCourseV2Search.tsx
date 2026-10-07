"use client";

import Link from "next/link";
import { useState } from "react";
import { searchMathCourseV2Action } from "@/app/actions/math-course-v2";
import { OpenTextbookPageButton } from "@/components/shared/BookPageModal";
import { MathText } from "@/components/shared/MathText";
import type { MathCourseV2SearchLessonHit, MathCourseV2SearchResult, MathCourseV2SearchTextbook } from "@/server/lessons/mathCourseV2Search";

const DIGITS_ONLY = /^\d{1,4}$/;

/**
 * PO request 2026-10-07: "пошук уроків за сторінкою в книзі або за номером
 * задачі" — a single smart box instead of two separate number fields (PO
 * feedback on the first version, "можливо можна покращити"): type a word
 * and it searches lesson TITLES; type a bare number and — since the child
 * doesn't necessarily know whether it's a textbook page or an exercise
 * number — it searches BOTH at once and shows whichever groups come back
 * non-empty. Shown on the subject screen, above the topic list, always
 * visible (not collapsed) now that it is a primary way to reach a lesson,
 * not a rarely-used extra.
 */
export function MathCourseV2Search({ subjectId, textbook }: { subjectId: string; textbook: MathCourseV2SearchTextbook | null }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "ok"; result: MathCourseV2SearchResult } | { status: "error"; message: string }>({
    status: "idle",
  });

  async function search() {
    const q = query.trim();
    if (!q) return;
    setState({ status: "loading" });
    const isNumber = DIGITS_ONLY.test(q);
    const res = await searchMathCourseV2Action(isNumber ? { subjectId, page: q, exerciseNumber: q } : { subjectId, topicQuery: q });
    if (res.status === "ok") setState({ status: "ok", result: res.result });
    else setState({ status: "error", message: res.message });
  }

  const lessons: MathCourseV2SearchLessonHit[] =
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
          placeholder="Тема, номер задачі або сторінка підручника…"
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
          {lessons.length === 0 && state.result.exercisesByNumber.length === 0 && <p className="text-sm text-muted">Нічого не знайдено.</p>}
          {lessons.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
              <Link href={`/math-course-v2/${l.id}`} className="font-semibold">
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
          {state.result.exercisesByNumber.map((e) => (
            <div key={e.exerciseId} className="rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/math-course-v2/${e.lessonId}`} className="font-semibold">
                  📘 № {e.originalNumber} · {e.lessonTitle}
                </Link>
                {textbook && e.printedPage != null && (
                  <OpenTextbookPageButton materialId={textbook.materialId} title={textbook.title} pageCount={textbook.pageCount} page={e.printedPage} />
                )}
              </div>
              <p className="mt-1 text-muted">
                <MathText text={e.displayMd.slice(0, 160)} />
                {e.displayMd.length > 160 ? "…" : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
