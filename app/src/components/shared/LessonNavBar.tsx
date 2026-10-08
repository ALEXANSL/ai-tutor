"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
 */
export function LessonNavBar({ subjectId, courseNav }: { subjectId: string; courseNav?: CourseNavProps }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  useRememberLastLesson(subjectId, courseNav);

  const goHome = () => {
    setBusy(true);
    router.push("/today");
  };
  const goSubjectList = () => {
    setBusy(true);
    router.push(`/subject/${subjectId}`);
  };

  const activeLessons = courseNav?.lessons.filter((l) => l.status === "active") ?? [];
  const currentIndex = activeLessons.findIndex((l) => l.id === courseNav?.currentLessonId);
  const prevLesson = currentIndex > 0 ? activeLessons[currentIndex - 1] : null;
  const nextLesson = currentIndex >= 0 && currentIndex < activeLessons.length - 1 ? activeLessons[currentIndex + 1] : null;

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
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
        <button type="button" onClick={goHome} className="min-h-11 rounded-full bg-danger px-4 text-sm font-bold text-white">
          {t.alarmButton}
        </button>
      </div>
      {courseNav && (
        <div className="mt-2">
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
            <div className="mt-2 max-h-72 overflow-y-auto rounded-2xl border border-line bg-surface p-2">
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
    </div>
  );
}
