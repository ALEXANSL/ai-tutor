"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { uk } from "@/i18n/uk";

const t = uk.child.lesson;

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
export function LessonNavBar({ subjectId }: { subjectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const goHome = () => {
    setBusy(true);
    router.push("/today");
  };
  const goSubjectList = () => {
    setBusy(true);
    router.push(`/subject/${subjectId}`);
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
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
  );
}
