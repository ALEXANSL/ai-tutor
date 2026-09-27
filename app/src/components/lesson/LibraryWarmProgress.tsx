"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { checkWarmupProgressAction } from "@/app/actions/lesson";
import { ChildCard } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";

// Perf pass (2026-09-27): a full generate→review wait can run several
// minutes (up to `MAX_REVIEW_PASSES` AI-call passes). Polling stays snappy
// at the start, when the child is most likely still watching, then backs
// off so a long wait doesn't keep hitting the DB every 3s for minutes on
// end — this only changes how often the client asks, never what the
// pipeline itself does.
const POLL_MS_INITIAL = 3000;
const POLL_MS_AFTER_30S = 5000;
const POLL_MS_AFTER_90S = 8000;
function nextPollMs(elapsedMs: number): number {
  if (elapsedMs >= 90_000) return POLL_MS_AFTER_90S;
  if (elapsedMs >= 30_000) return POLL_MS_AFTER_30S;
  return POLL_MS_INITIAL;
}
const STAGE_ORDER = ["planning", "generating", "reviewing", "revising", "saving"] as const;
type Stage = (typeof STAGE_ORDER)[number];

/**
 * ADR-023 (D-76): shown instead of a static "Готуємо урок…" while a topic's
 * first library block is being generated in the background
 * (`library.warm_topic`, `mode === "warming"`) — a "чесний поетапний
 * прогрес" the whole ~60–90s the pipeline can take, polling
 * `checkWarmupProgressAction` every few seconds and refreshing the page the
 * moment the session moves itself on to `choosing` (a real block) or the
 * safe fallback template — never leaves the child stuck here.
 *
 * A brand-new component (not a change to `LessonPicker`/`LessonPausedScreen`)
 * so this ADR's work does not collide with the parallel US-6.16 navigation
 * slice editing those files.
 */
// BUG-035: total generate→review passes possible (first pass + up to 2
// revisions) — mirrors `MAX_REVIEW_PASSES` in `pipeline.ts` (server-only, so
// not importable directly from this client component; kept in sync by hand,
// same as `STAGE_ORDER` already is with `PipelineStage`).
const MAX_REVIEW_PASSES = 3;
// A real wait can run 3+ AI-call passes and take several minutes — after
// this long, add a reassuring note (without touching the pipeline itself).
const SLOW_WAIT_MS = 90_000;

export function LibraryWarmProgress({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("planning");
  const [reviewPass, setReviewPass] = useState<number | null>(null);
  const [slowWait, setSlowWait] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      const result = await checkWarmupProgressAction(sessionId);
      if (cancelledRef.current) return;
      if (result.status === "ok") {
        if (result.ready) {
          router.refresh();
          return;
        }
        if (result.stage && (STAGE_ORDER as readonly string[]).includes(result.stage)) {
          setStage(result.stage as Stage);
        }
        setReviewPass(result.reviewPass ?? null);
      }
      timer = setTimeout(poll, nextPollMs(Date.now() - startedAt));
    }

    // First check right away — no need to wait a full POLL_MS_INITIAL just
    // to show the actual current stage instead of the "planning" default.
    void poll();
    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [sessionId, router]);

  useEffect(() => {
    const id = setTimeout(() => setSlowWait(true), SLOW_WAIT_MS);
    return () => clearTimeout(id);
  }, []);

  const t = uk.child.lesson.warmup;
  // BUG-035: "Перевірка X з N" on the passes that actually have a pass
  // number, instead of just repeating the bare stage label — makes the
  // repeated generating/reviewing/revising loop read as a bounded,
  // step-by-step quality check rather than the app looping/being stuck.
  const stageLabels: Record<Stage, string> = {
    planning: t.stagePlanning,
    generating: reviewPass ? t.stagePassLabel(reviewPass, MAX_REVIEW_PASSES) : t.stageGenerating,
    reviewing: reviewPass ? t.stagePassLabel(reviewPass, MAX_REVIEW_PASSES) : t.stageReviewing,
    revising: reviewPass ? t.stagePassLabel(reviewPass, MAX_REVIEW_PASSES) : t.stageRevising,
    saving: t.stageSaving,
  };
  const activeIndex = Math.max(0, STAGE_ORDER.indexOf(stage));

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <ChildCard>
        <div className="mb-4 text-5xl" aria-hidden>
          ✨
        </div>
        <h1 className="mb-2 text-xl font-bold text-text">{t.title}</h1>
        <p className="mb-6 text-sm text-text-muted">{t.etaHint}</p>
        <ol className="space-y-2 text-left" aria-live="polite">
          {STAGE_ORDER.map((s, i) => (
            <li
              key={s}
              className={`flex items-center gap-2 rounded-2xl px-4 py-3 text-base ${
                i === activeIndex ? "bg-surface-alt font-bold text-text" : i < activeIndex ? "text-secondary" : "text-text-muted"
              }`}
            >
              <span aria-hidden>{i < activeIndex ? "✓" : i === activeIndex ? "…" : "•"}</span>
              {stageLabels[s]}
            </li>
          ))}
        </ol>
        {slowWait && (
          <p className="mt-4 text-sm text-text-muted" role="status">
            {t.slowWaitHint}
          </p>
        )}
      </ChildCard>
    </div>
  );
}
