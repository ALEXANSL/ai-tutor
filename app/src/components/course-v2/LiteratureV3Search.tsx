"use client";

import Link from "next/link";
import { useState } from "react";
import { searchLiteratureV3Action } from "@/app/actions/literature-v3";
import type { LiteratureV3SearchLessonHit, LiteratureV3SearchResult, LiteratureV3SearchWorkHit } from "@/server/lessons/literatureV3Search";

const DIGITS_ONLY = /^\d{1,4}$/;

/**
 * S45 (part 3/4 of this slice) — `literature_v3`'s own version of
 * `LiteratureV2Search.tsx`/`MathCourseV2Search.tsx`: one smart box (a bare
 * number searches the textbook page, free text searches lesson titles AND
 * work titles at once — this package's own new `worksByTitle` capability,
 * see `literatureV3Search.ts`'s header). No "Відкрити підручник" shortcut
 * button here (unlike the other two formats' textbook `materialId`) — this
 * format's book is the small, per-lesson `VirtualBookReader`, already one
 * tap away from each lesson/reading step itself (US-31.3); searching here is
 * about finding the right LESSON, not the raw PDF.
 */
export function LiteratureV3Search({ subjectId }: { subjectId: string }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "ok"; result: LiteratureV3SearchResult } | { status: "error"; message: string }>({
    status: "idle",
  });

  async function search() {
    const q = query.trim();
    if (!q) return;
    setState({ status: "loading" });
    const isNumber = DIGITS_ONLY.test(q);
    const res = await searchLiteratureV3Action(isNumber ? { subjectId, page: q } : { subjectId, topicQuery: q, workQuery: q });
    if (res.status === "ok") setState({ status: "ok", result: res.result });
    else setState({ status: "error", message: res.message });
  }

  const lessons: LiteratureV3SearchLessonHit[] =
    state.status === "ok"
      ? [...state.result.lessonsByPage, ...state.result.lessonsByTopic].filter((l, i, arr) => arr.findIndex((o) => o.id === l.id) === i)
      : [];
  const works: LiteratureV3SearchWorkHit[] = state.status === "ok" ? state.result.worksByTitle : [];

  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Тема уроку, назва твору або сторінка підручника…"
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
      </div>

      {state.status === "error" && (
        <p role="alert" className="mt-2 text-sm font-bold text-danger">
          {state.message}
        </p>
      )}

      {state.status === "ok" && (
        <div className="mt-3 flex flex-col gap-2">
          {lessons.length === 0 && works.length === 0 && <p className="text-sm text-muted">Нічого не знайдено.</p>}
          {lessons.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
              <Link href={`/literature-v3/${l.id}`} className="font-semibold">
                📘 {l.title}
                {l.printedPageFrom != null && (
                  <span className="font-normal text-muted"> · с. {l.printedPageFrom}{l.printedPageTo && l.printedPageTo !== l.printedPageFrom ? `–${l.printedPageTo}` : ""}</span>
                )}
              </Link>
            </div>
          ))}
          {works.map((w) => (
            <div key={w.id} className="rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
              <p className="font-semibold">
                📖 «{w.title}»{w.author ? <span className="font-normal text-muted"> · {w.author}</span> : null}
              </p>
              {w.lessons.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {w.lessons.map((l) => (
                    <Link key={l.id} href={`/literature-v3/${l.id}`} className="text-xs font-bold text-primary underline">
                      {l.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
