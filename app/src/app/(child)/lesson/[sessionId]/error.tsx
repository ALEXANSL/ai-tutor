"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ChildCard, primaryButton, ghostButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";

/**
 * BUG-016 (live demo): choosing a lesson block could crash the *next*
 * render (`/lesson/[sessionId]` re-rendering after `router.refresh()`) with
 * Next's generic "a server error occurred" page — a child must never see
 * that. This route-segment `error.tsx` catches any render-time exception on
 * this screen instead and offers exactly what the child needs: try again,
 * or go back to "Сьогодні" (nothing already saved is lost — the orchestrator
 * only ever advances a session after its own write succeeds).
 */
export default function LessonError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = uk.child.lesson;

  useEffect(() => {
    console.error(`lesson screen crashed: ${error.message}`, error.digest ? `(digest: ${error.digest})` : "");
  }, [error]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-8">
      <ChildCard>
        <h1 className="mb-2 text-2xl font-extrabold">{t.crashTitle}</h1>
        <p className="mb-6 text-sm text-muted">{t.crashBody}</p>
        <div className="grid gap-3">
          <button type="button" onClick={reset} className={primaryButton}>
            {t.crashRetry}
          </button>
          <Link href="/today" className={ghostButton}>
            {t.crashBackToToday}
          </Link>
        </div>
      </ChildCard>
    </div>
  );
}
