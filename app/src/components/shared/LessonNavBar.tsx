"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { uk } from "@/i18n/uk";

const t = uk.child.lesson;

export interface LessonNavListItem {
  id: string;
  orderNo: number;
  title: string;
  status: "active" | "needs_review";
}

/**
 * S37 (PO 2026-10-08): "уявляй ти листаєш підручник, кожного разу щоб
 * відкрити наступну сторінку не потрібно закривати книгу" — prev/next
 * lesson links plus a table-of-contents dropdown, so switching lessons
 * never leaves this screen for the topic list and back. Only wired for
 * course-v2 packages so far (math-v2, literature-v2) since those are the
 * only lesson types with an ordered package lesson list to show here —
 * optional props so the older S33/S34 viewers keep working unchanged.
 */
interface CourseNavProps {
  basePath: string;
  currentLessonId: string;
  lessons: LessonNavListItem[];
  topicId: string | null;
}

function useRememberLastLesson(subjectId: string, nav: CourseNavProps | undefined) {
  useEffect(() => {
    if (!nav?.topicId) return;
    try {
      localStorage.setItem(`lastLesson:${subjectId}`, JSON.stringify({ topicId: nav.topicId }));
    } catch {
      // Best-effort only — a private window or blocked storage just means
      // no highlight next time, never a broken lesson screen.
    }
  }, [subjectId, nav?.topicId]);
}

/**
 * Measures the rendered height of a fixed element and reports it back, so a
 * caller can reserve exactly that much space in normal document flow — a
 * `ResizeObserver` instead of a guessed Tailwind spacer class, because the
 * bar's real height depends on things no single constant can predict
 * (viewport width, how many buttons wrap, font scaling, `courseNav`/
 * `extraControls` being present or not). PO complaint 2026-10-16 ("верхню
 * панель переробити, налізає на текст"): the previous fixed `pt-48` spacer
 * undercounted a narrower viewport where the top row wrapped onto an extra
 * line, so the fixed bar covered the first lines of lesson content.
 */
function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    // Not available in every environment (e.g. the component test's jsdom)
    // — degrades to no spacer rather than throwing.
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

/**
 * 2026-10-02: the S33/S34 "minimal viewer" lesson screens
 * (`LiteratureLessonView.tsx`/`CourseLessonView.tsx`) never had a navigation
 * header at all, unlike the old `LessonRunner.tsx` — PO feedback: "навігація
 * пропала... відкриває тупо файл з картинками". This is the same
 * "На головну"/"Список уроків предмету"/"Вийти з уроку"/"🚨 Тривога" group
 * `LessonRunner` has (docs/04 §11.4, BUG-020/026), reused as a shared
 * component since both screens need the identical bar.
 *
 * These screens have no `lesson_sessions` row to pause (S33/S34 are
 * stateless content views, not the old step machine) — so unlike
 * `LessonRunner`'s `alarm`/`exitLesson` there is nothing to save first.
 * Every button here is therefore immediate navigation, no confirm dialog:
 * "Вийти з уроку" and "На головну" both just leave to `/today`, and
 * "Тривога" does the same (instantly, no friction — that is the point of a
 * panic button) with its brighter, unmissable styling kept as-is.
 *
 * PO complaint 2026-10-16 ("нижня панель навігації супер, а давай верхню
 * панель таку саму зробимо і там розмістимо всі наші елементи"): fixed to
 * the top of the viewport (not the document flow), same treatment as
 * `StepNavBar` at the bottom — this bar, plus each viewer's own "open
 * textbook"/voice-mode/autoplay controls (now passed in via
 * `extraControls`, rendered in the SAME bar), stay in the exact same
 * on-screen position regardless of scroll or lesson content length. The
 * TOC dropdown is rendered as an absolute overlay (not in normal flow)
 * precisely so opening/closing it never changes this bar's own height —
 * a changing fixed-bar height would just reintroduce the "stuff jumps
 * around" problem one level up.
 *
 * PO follow-up same day ("верхню панель переробити, налізає на текст, і
 * кнопку тривога можна десь винести з основного управління"):
 * 1. "🚨 Тривога" moved OUT of the wrapping button row entirely — it's a
 *    panic button, not an everyday control, and it was the widest item in
 *    that row, the one most likely to wrap onto its own line and throw off
 *    the bar's height. It's now a small, separate, always-on-top corner
 *    button (`fixed top-3.5 left-3.5 z-50`) — the mirror image of the
 *    existing `ThemeToggle` (`fixed top-3.5 right-3.5 z-50`), so it stays
 *    reachable from anywhere in the app, not just lesson screens, without
 *    crowding the lesson-specific controls.
 * 2. The component itself now renders its own spacer (see
 *    `useMeasuredHeight` above) sized to its OWN measured height, instead
 *    of asking every caller to guess a Tailwind class — this is the actual
 *    fix for "налізає на текст": no fixed constant can account for every
 *    viewport width this bar might wrap at.
 */
export function LessonNavBar({ subjectId, courseNav, extraControls }: { subjectId: string; courseNav?: CourseNavProps; extraControls?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [barRef, barHeight] = useMeasuredHeight<HTMLDivElement>();
  useRememberLastLesson(subjectId, courseNav);

  const goHome = () => {
    setBusy(true);
    router.push("/today");
  };
  const goSubjectList = () => {
    setBusy(true);
    router.push(`/subject/${subjectId}`);
  };
  const goAlarm = () => {
    setBusy(true);
    router.push("/today");
  };

  const activeLessons = courseNav?.lessons.filter((l) => l.status === "active") ?? [];
  const currentIndex = activeLessons.findIndex((l) => l.id === courseNav?.currentLessonId);
  const prevLesson = currentIndex > 0 ? activeLessons[currentIndex - 1] : null;
  const nextLesson = currentIndex >= 0 && currentIndex < activeLessons.length - 1 ? activeLessons[currentIndex + 1] : null;

  return (
    <>
      {/* Spacer in normal document flow — reserves exactly as much room as
          the fixed bar below actually renders at, so lesson content never
          starts underneath it. */}
      <div style={{ height: barHeight }} aria-hidden="true" />
      <button
        type="button"
        onClick={goAlarm}
        className="fixed top-3.5 left-3.5 z-50 min-h-11 rounded-full bg-danger px-4 text-sm font-bold text-white shadow-sm"
      >
        {t.alarmButton}
      </button>
      <div ref={barRef} className="fixed inset-x-0 top-0 z-40 border-b border-line bg-surface/95 backdrop-blur" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="mx-auto max-w-2xl px-4 py-2.5">
          {/* `pl-14`/`pr-14` reserve room for the alarm button (top-left) and
              the always-on-top `ThemeToggle` pill (top-right, `fixed
              top-3.5 right-3.5 z-50` in the child layout) so this row's own
              buttons never render underneath either one. */}
          <div className="flex flex-wrap items-center gap-2 pl-14 pr-14">
            <button type="button" onClick={goHome} disabled={busy} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-60">
              {t.navHome}
            </button>
            <button type="button" onClick={goSubjectList} disabled={busy} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-60">
              {t.navSubjectList}
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={goHome}
              disabled={busy}
              className="min-h-11 rounded-full border-2 border-text/40 bg-surface-alt px-4 text-sm font-bold text-text disabled:opacity-60"
            >
              {t.exitLesson}
            </button>
          </div>
          {courseNav && (
            <div className="relative mt-2">
              <div className="flex flex-wrap items-center gap-2">
                {prevLesson ? (
                  <Link href={`${courseNav.basePath}/${prevLesson.id}`} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold leading-[2.5rem]">
                    {t.navPrevLesson}
                  </Link>
                ) : (
                  <span className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold leading-[2.5rem] text-muted opacity-50">{t.navPrevLesson}</span>
                )}
                <button type="button" onClick={() => setTocOpen((v) => !v)} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold" aria-expanded={tocOpen}>
                  📖 {t.navToc} {tocOpen ? "▲" : "▼"}
                </button>
                {nextLesson ? (
                  <Link href={`${courseNav.basePath}/${nextLesson.id}`} className="min-h-11 rounded-full bg-primary px-3.5 text-sm font-bold leading-[2.5rem] text-white">
                    {t.navNextLesson}
                  </Link>
                ) : (
                  <span className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold leading-[2.5rem] text-muted opacity-50">{t.navNextLesson}</span>
                )}
              </div>
              {tocOpen && (
                <div className="absolute inset-x-0 top-full z-10 mt-2 max-h-72 overflow-y-auto rounded-2xl border border-line bg-surface p-2 shadow-lg">
                  {courseNav.lessons.map((l) => (
                    <Link
                      key={l.id}
                      href={`${courseNav.basePath}/${l.id}`}
                      onClick={() => setTocOpen(false)}
                      className={`block rounded-xl px-3 py-2 text-sm ${
                        l.id === courseNav.currentLessonId ? "bg-primary/10 font-bold text-primary" : l.status === "needs_review" ? "text-muted" : "hover:bg-surface-alt"
                      }`}
                    >
                      {l.orderNo}. {l.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
          {extraControls && <div className="mt-2 flex flex-wrap gap-2">{extraControls}</div>}
        </div>
      </div>
    </>
  );
}
