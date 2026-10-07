"use client";

import Link from "next/link";
import { useState } from "react";
import { searchMathCourseV2Action } from "@/app/actions/math-course-v2";
import { MathText } from "@/components/shared/MathText";
import type { MathCourseV2SearchResult } from "@/server/lessons/mathCourseV2Search";

/** PO request 2026-10-07: "пошук уроків за сторінкою в книзі або за номером
 * задачі" — this package has no page images/PDF (pure text), so this
 * searches the lesson/exercise metadata already imported, not a scanned
 * page. Shown on the subject screen, above the topic list. */
export function MathCourseV2Search({ subjectId }: { subjectId: string }) {
  const [page, setPage] = useState("");
  const [exerciseNumber, setExerciseNumber] = useState("");
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "ok"; result: MathCourseV2SearchResult } | { status: "error"; message: string }>({
    status: "idle",
  });

  async function search() {
    setState({ status: "loading" });
    const res = await searchMathCourseV2Action({ subjectId, page, exerciseNumber });
    if (res.status === "ok") setState({ status: "ok", result: res.result });
    else setState({ status: "error", message: res.message });
  }

  return (
    <details className="mb-4 rounded-2xl border border-line bg-surface p-3.5">
      <summary className="cursor-pointer text-sm font-bold">🔎 Знайти урок за сторінкою чи номером задачі</summary>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold text-muted">Сторінка підручника</span>
          <input
            type="number"
            inputMode="numeric"
            value={page}
            onChange={(e) => setPage(e.target.value)}
            className="min-h-11 w-28 rounded-xl border-2 border-line bg-surface px-2.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold text-muted">Номер задачі</span>
          <input
            type="text"
            inputMode="numeric"
            value={exerciseNumber}
            onChange={(e) => setExerciseNumber(e.target.value)}
            className="min-h-11 w-28 rounded-xl border-2 border-line bg-surface px-2.5 text-sm"
          />
        </label>
        <button type="button" onClick={() => void search()} disabled={state.status === "loading"} className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-60">
          {state.status === "loading" ? "Шукаю…" : "Знайти"}
        </button>
      </div>

      {state.status === "error" && (
        <p role="alert" className="mt-2 text-sm font-bold text-danger">
          {state.message}
        </p>
      )}

      {state.status === "ok" && (
        <div className="mt-3 flex flex-col gap-2">
          {state.result.lessonsByPage.length === 0 && state.result.exercisesByNumber.length === 0 && (
            <p className="text-sm text-muted">Нічого не знайдено.</p>
          )}
          {state.result.lessonsByPage.map((l) => (
            <Link key={l.id} href={`/math-course-v2/${l.id}`} className="rounded-xl border border-line bg-surface-alt p-2.5 text-sm font-semibold">
              📖 {l.title}
              {l.printedPageFrom != null && <span className="font-normal text-muted"> · с. {l.printedPageFrom}{l.printedPageTo && l.printedPageTo !== l.printedPageFrom ? `–${l.printedPageTo}` : ""}</span>}
            </Link>
          ))}
          {state.result.exercisesByNumber.map((e) => (
            <Link key={e.exerciseId} href={`/math-course-v2/${e.lessonId}`} className="rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
              <span className="font-semibold">№ {e.originalNumber} · {e.lessonTitle}</span>
              <p className="mt-1 text-muted">
                <MathText text={e.displayMd.slice(0, 160)} />
                {e.displayMd.length > 160 ? "…" : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </details>
  );
}
