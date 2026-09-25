"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChildCard, primaryButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";
import { resumeLessonAction } from "@/app/actions/lesson";

const REASON_TEXT: Record<string, string> = {
  manual_alert: "Ти натиснула «Тривога» — усе збережено.",
  air_alert: "Заняття призупинено через повітряну тривогу.",
  idle: "Заняття на паузі — ти давно нічого не робила.",
  network: "Зв'язок пропав — усе збережено.",
  budget_hard: "Заняття зараз на паузі.",
  parent_mode: "Заняття на паузі.",
};

/**
 * US-6.5 КП-1: "Продовжити" reopens the exact step it paused on. КП-3
 * (BUG-008 fix): if the pause lasted 24h+, `resumeLessonAction` also returns
 * a short reminder slide, shown once here before the step itself loads.
 */
export function LessonPausedScreen({ sessionId, reason }: { sessionId: string; reason: string | null }) {
  const t = uk.child.lesson;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reminder, setReminder] = useState<string | null>(null);

  function resume() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await resumeLessonAction(sessionId);
        if (result.reminder) setReminder(result.reminder.textUk);
        else router.refresh();
      } catch {
        setError(uk.common.error);
      }
    });
  }

  if (reminder) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center px-4 py-8">
        <ChildCard>
          <p className="mb-2 text-sm font-bold text-muted">{t.reminderTitle}</p>
          <p className="mb-6 whitespace-pre-line text-lg">{reminder}</p>
          <button type="button" onClick={() => router.refresh()} className={primaryButton}>
            {t.reminderContinue}
          </button>
        </ChildCard>
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-8">
      <ChildCard>
        <p className="mb-6 text-lg font-bold">{REASON_TEXT[reason ?? ""] ?? REASON_TEXT.parent_mode}</p>
        <button type="button" disabled={pending} onClick={resume} className={primaryButton}>
          {t.resume}
        </button>
        {error && <p className="mt-3 text-sm font-semibold text-danger">{error}</p>}
      </ChildCard>
    </div>
  );
}
