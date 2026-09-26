"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChildCard, primaryButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";
import { chooseStartBlockAction } from "@/app/actions/lesson";

/** US-16.6 КП-1 / US-9.1 КП-2: choose from 2–3 offered blocks to start with. */
export function LessonPicker({
  sessionId,
  candidates,
}: {
  sessionId: string;
  candidates: { id: string; title: string; estimatedMinutes: number | null }[];
}) {
  const t = uk.child.lesson;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function pick(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await chooseStartBlockAction(sessionId, id);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        router.refresh();
      } catch {
        // BUG-016: `chooseStartBlockAction` now always resolves with
        // `{status: "error", ...}` on failure rather than throwing, but this
        // stays as a last-resort net for a genuine transport-level failure.
        setError(uk.common.error);
      }
    });
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-8">
      <ChildCard wide>
        <h1 className="mb-1 text-2xl font-extrabold">{t.pickTitle}</h1>
        <p className="mb-6 text-sm text-muted">{t.pickSubtitle}</p>
        <div className="grid gap-3">
          {candidates.map((c) => (
            <button key={c.id} type="button" disabled={pending} onClick={() => pick(c.id)} className={primaryButton}>
              {c.title}
              {c.estimatedMinutes ? ` · ~${c.estimatedMinutes} хв` : ""}
            </button>
          ))}
        </div>
        {error && <p className="mt-3 text-sm font-semibold text-danger">{error}</p>}
      </ChildCard>
    </div>
  );
}
