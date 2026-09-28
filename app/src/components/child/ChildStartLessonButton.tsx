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
  // BUG (child-facing leak): `startLessonAction`'s `message` for
  // `reason === "no_textbook"` is worded for the PARENT ("додайте й
  // проіндексуйте його в «Мої книги»" — a screen the child cannot reach).
  // `notReady` tracks that specific case separately so this component can
  // show its own child-friendly copy instead, and hide "Почати": retrying
  // would just fail the same way again until a parent indexes the book.
  const [notReady, setNotReady] = useState(false);
  const t = uk.child.lesson;

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await startLessonAction(subjectId, topicId);
      if (result.status === "error") {
        if (result.reason === "no_textbook") {
          setNotReady(true);
        } else {
          setError(result.message);
        }
        return;
      }
      router.push(`/lesson/${result.sessionId}`);
    });
  }

  if (notReady) {
    return (
      <div>
        <p className="font-bold">{t.notReadyTitle}</p>
        <p className="mt-1 text-sm text-muted">{t.notReadyBody}</p>
      </div>
    );
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
