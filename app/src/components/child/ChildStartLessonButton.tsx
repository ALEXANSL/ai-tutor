"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { startLessonAction } from "@/app/actions/lesson";
import { uk } from "@/i18n/uk";

/** S4: the child's own "Почати урок" (the S3 "тато-only" entry point was `StartLessonButton`). */
export function ChildStartLessonButton({ subjectId, topicId }: { subjectId: string; topicId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const t = uk.child.lesson;

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await startLessonAction(subjectId, topicId);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      router.push(`/lesson/${result.sessionId}`);
    });
  }

  return (
    <div>
      <button type="button" disabled={pending} onClick={start} className="inline-flex min-h-12 items-center rounded-2xl bg-primary px-5 text-base font-bold text-white disabled:opacity-60">
        {pending ? t.startingLesson : t.startAny}
      </button>
      {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}
