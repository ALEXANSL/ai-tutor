"use client";

import Link from "next/link";
import { VideoLessonButton } from "@/components/child/VideoLessonButton";

/** Fixed lesson tools and forward/exit actions. Navigation never marks a
 * lesson or quiz completed; the caller owns the current step and progress. */
export function StepNavBar({ label, onBack, onNext, backDisabled, nextDisabled, middleControl, videoTopicId, isLessonEnd = false, nextLessonHref }: {
  label: string; onBack: () => void; onNext: () => void;
  backDisabled: boolean; nextDisabled: boolean; middleControl?: React.ReactNode;
  videoTopicId?: string | null; isLessonEnd?: boolean; nextLessonHref?: string | null;
}) {
  const numbers = /(\d+)\s+з\s+(\d+)/u.exec(label);
  const shortLabel = numbers ? `${numbers[1]}/${numbers[2]}` : label;
  return <div data-step-nav data-lesson-end={isLessonEnd || undefined} className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
    <div className="lesson-step-layout">
      <div className="lesson-step-row lesson-step-tools">
        <button type="button" aria-label="Назад" disabled={backDisabled} onClick={onBack} className="lesson-step-button">
          <span className="lesson-step-full">← Назад</span><span className="lesson-compact-only" aria-hidden="true">←</span>
        </button>
        <p title={label} className="min-w-0 flex-1 truncate text-center text-xs font-bold text-muted"><span className="sr-only">{label}</span><span className="lesson-progress-full" aria-hidden="true">{label}</span><span className="lesson-progress-short" aria-hidden="true">{shortLabel}</span></p>
        {videoTopicId && <div data-video-control><VideoLessonButton topicId={videoTopicId} compact /></div>}
        {middleControl && <div data-book-control title="Відкрити підручник">{middleControl}</div>}
      </div>
      <div className="lesson-step-primary">
        {isLessonEnd ? <>
          <Link href="/today" className="lesson-step-button lesson-exit">Вийти з уроку</Link>
          {nextLessonHref && <Link href={nextLessonHref} className="lesson-step-button lesson-next-lesson">Наступний урок →</Link>}
        </> : <button type="button" disabled={nextDisabled} onClick={onNext} className="lesson-step-button lesson-next-lesson">Далі →</button>}
      </div>
    </div>
  </div>;
}

export const STEP_NAV_BAR_SPACER_CLASS = "pb-20";
