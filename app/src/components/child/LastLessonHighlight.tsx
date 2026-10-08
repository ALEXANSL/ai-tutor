"use client";

import { useEffect, useState } from "react";
import { uk } from "@/i18n/uk";

const t = uk.child.subject;

/**
 * S37 (PO 2026-10-08): "remember the last lesson and highlight it" — reads
 * the `lastLesson:<subjectId>` key `LessonNavBar` writes from inside a
 * course-v2 lesson screen, and highlights the matching topic card here.
 * Lazy-read after mount only (avoids an SSR/client render mismatch, same
 * reasoning as the voice-mode/auto-advance toggles elsewhere in course-v2).
 */
export function LastLessonHighlight({
  subjectId,
  topicId,
  children,
}: {
  subjectId: string;
  topicId: string;
  children: React.ReactNode;
}) {
  const [isLast, setIsLast] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem(`lastLesson:${subjectId}`);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { topicId?: string };
        setIsLast(parsed.topicId === topicId);
      } catch {
        // best-effort only — no highlight is fine, a crash is not
      }
    });
    return () => {
      cancelled = true;
    };
  }, [subjectId, topicId]);

  return (
    <div
      className={isLast ? "relative rounded-[22px] ring-2 ring-primary" : ""}
    >
      {isLast && (
        <span className="absolute -top-2.5 left-3 rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-white">
          ▶ {t.continueBadge}
        </span>
      )}
      {children}
    </div>
  );
}
