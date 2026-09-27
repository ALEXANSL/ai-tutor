"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { checkWarmupProgressAction } from "@/app/actions/lesson";
import { ChildCard } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";

const POLL_MS = 3000;
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
export function LibraryWarmProgress({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("planning");
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
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
      }
      timer = setTimeout(poll, POLL_MS);
    }

    // First check right away — no need to wait a full POLL_MS just to show
    // the actual current stage instead of the "planning" default.
    void poll();
    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
  }, [sessionId, router]);

  const t = uk.child.lesson.warmup;
  const stageLabels: Record<Stage, string> = {
    planning: t.stagePlanning,
    generating: t.stageGenerating,
    reviewing: t.stageReviewing,
    revising: t.stageRevising,
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
      </ChildCard>
    </div>
  );
}
