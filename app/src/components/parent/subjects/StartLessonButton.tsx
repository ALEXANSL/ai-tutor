"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { uk } from "@/i18n/uk";
import { startLessonAction } from "@/app/actions/lesson";

/**
 * S3 demo entry point: starts a lesson session from the parent cabinet.
 * There is no child-facing "Почати урок" yet on purpose (the lesson is
 * father-mode-only until S4, see docs/STATUS.md).
 */
export function StartLessonButton({ subjectId, topicId }: { subjectId: string; topicId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const t = uk.parent.subjects.detail;

  function start() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await startLessonAction(subjectId, topicId);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        router.push(`/lesson/${result.sessionId}`);
      } catch {
        // Only an unexpected transport-level failure reaches here now —
        // BUG-011: known failure reasons are already turned into a specific
        // `result.message` above instead of a thrown error.
        setError(uk.common.error);
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={start}
        className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60"
      >
        {pending ? t.startingLesson : t.startLesson}
      </button>
      {error && <p className="mt-2 text-[13px] text-p-danger">{error}</p>}
    </div>
  );
}
