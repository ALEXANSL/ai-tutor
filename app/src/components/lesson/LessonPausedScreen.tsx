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

/** US-6.5 КП-1: "Продовжити" reopens the exact step it paused on. */
export function LessonPausedScreen({ sessionId, reason }: { sessionId: string; reason: string | null }) {
  const t = uk.child.lesson;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function resume() {
    setError(null);
    startTransition(async () => {
      try {
        await resumeLessonAction(sessionId);
        router.refresh();
      } catch {
        setError(uk.common.error);
      }
    });
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
