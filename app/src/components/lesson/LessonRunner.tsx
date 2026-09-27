"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DragSortStep } from "@/lesson-components/drag_sort/DragSortStep";
import type { DragSortProps } from "@/lesson-components/drag_sort";
import { uk } from "@/i18n/uk";
import {
  acknowledgeSlideAction,
  askTopicChatAction,
  continueAfterBlockAction,
  explainStepAction,
  getPreviousModuleAction,
  pauseLessonAction,
  setPresentationModeAction,
  skipLessonBreakAction,
  submitBlockFeedbackAction,
  submitStepAnswerAction,
  synthesizeNarrationAction,
  takeLessonBreakAction,
  tickLessonActivityAction,
} from "@/app/actions/lesson";
import { dequeueAnswer, listQueuedAnswers, resendQueued, submitAnswerOffline, type QueuedAnswer } from "./offlineQueue";

type PresentationMode = "voice" | "auto" | "text";

type AnswerResultView = Awaited<ReturnType<typeof submitStepAnswerAction>>;
type NextView = AnswerResultView["next"];

type Labels = typeof uk.child.lesson;

interface StepView {
  stepId: string;
  type: string;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  sourceRefs: { materialId: string; materialTitle: string; page: number | null }[];
  stepNumber: number;
  totalSteps: number;
}

/**
 * Runs one lesson step at a time (ADR-007: the server owns the state
 * machine, this component only shows the current step and reports events).
 * Idle hint/auto-pause (US-16.4), the alarm button (US-6.6) and the offline
 * banner (US-6.5) all live here since they are about *this device*.
 */
export function LessonRunner({
  sessionId,
  subjectId,
  topicId,
  step: initialStep,
  idleHintS,
  idlePauseS,
  presentationMode: initialPresentationMode,
}: {
  sessionId: string;
  subjectId: string;
  topicId: string;
  step: StepView;
  idleHintS: number;
  idlePauseS: number;
  presentationMode: PresentationMode;
}) {
  // BUG-017: `uk.child.lesson` (and, transitively, `sourceRef`/`stepOf`,
  // which are functions) must be imported directly here rather than
  // received as a `labels` prop from the server component in `page.tsx` —
  // a function value can't cross the server->client props boundary
  // ("Functions cannot be passed directly to Client Components..."). This
  // component is itself a client module, so importing the static `uk`
  // object (functions included) locally is safe; only the plain function
  // components nested below (in this same client file) still take
  // `labels` as an ordinary prop, which is fine since they never cross
  // that boundary.
  const t = uk.child.lesson;
  const router = useRouter();
  const [step, setStep] = useState(initialStep);
  const [stepStartedAt, setStepStartedAt] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<{ correct: boolean; text: string } | null>(null);
  const [formatOffer, setFormatOffer] = useState(false);
  const [showIdleHint, setShowIdleHint] = useState(false);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openAnswer, setOpenAnswer] = useState("");
  // BUG-007: the child's own selection stays visible while an answer is
  // queued offline, so she sees "what she did" rather than a blank step.
  const [queuedAnswer, setQueuedAnswer] = useState<{ channel: string; answer: unknown } | null>(null);
  const [blockComplete, setBlockComplete] = useState<{ libraryItemId: string; visibleOutcomeUk: string | null } | null>(null);
  const [breakOffer, setBreakOffer] = useState(false);
  // BUG-020: confirm before leaving, so an accidental tap never cuts off a
  // step mid-answer.
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  // US-6.16: navigation rail + speech-mode switch (docs/04 §5.2, §11.4).
  const [presentationMode, setPresentationModeState] = useState<PresentationMode>(initialPresentationMode);
  const [prevModule, setPrevModule] = useState<Awaited<ReturnType<typeof getPreviousModuleAction>>>(null);
  const [prevModuleBusy, setPrevModuleBusy] = useState(false);
  const [explainBusy, setExplainBusy] = useState(false);
  const chatRef = useRef<TopicChatHandle>(null);
  const lastInteractionRef = useRef<number>(0);
  useEffect(() => {
    lastInteractionRef.current = Date.now();
  }, []);

  const touch = useCallback(() => {
    lastInteractionRef.current = Date.now();
    setShowIdleHint(false);
  }, []);

  const alarm = useCallback(() => {
    setBusy(true);
    pauseLessonAction(sessionId, "manual_alert").finally(() => router.refresh());
  }, [sessionId, router]);

  // BUG-020: reuses the same pause mechanism as the alarm/idle/offline paths
  // (BUG-008's resume reminder is keyed off exactly this — `paused_at` +
  // `current_step_id`, untouched by a pause) so "Продовжити" on "Сьогодні"
  // picks the lesson back up on the same step, whether or not she had
  // already answered it.
  const exitLesson = useCallback(() => {
    setBusy(true);
    pauseLessonAction(sessionId, "manual_exit")
      .then(() => router.push("/today"))
      .catch(() => router.push("/today"))
      .finally(() => setBusy(false));
  }, [sessionId, router]);

  // US-6.16 КП-3 ("Повернутись на головну"): same save-and-pause mechanism as
  // "Вийти з уроку", but no confirmation (the requirement is explicit: a
  // save that finishes in ≤ 1 s needs none, NFR-PERF-6).
  const navHome = useCallback(() => {
    setBusy(true);
    pauseLessonAction(sessionId, "manual_exit")
      .then(() => router.push("/today"))
      .catch(() => router.push("/today"))
      .finally(() => setBusy(false));
  }, [sessionId, router]);

  // US-6.16 КП-4 ("Повернутись до списку уроків з предмету").
  const navSubjectList = useCallback(() => {
    setBusy(true);
    pauseLessonAction(sessionId, "manual_exit")
      .then(() => router.push(`/subject/${subjectId}`))
      .catch(() => router.push(`/subject/${subjectId}`))
      .finally(() => setBusy(false));
  }, [sessionId, subjectId, router]);

  // US-6.16 КП-2 ("Повернутись до попереднього модуля"): read-only preview,
  // no AI call, current step/progress untouched.
  const navPrevModule = useCallback(() => {
    setPrevModuleBusy(true);
    getPreviousModuleAction(sessionId)
      .then((view) => setPrevModule(view))
      .finally(() => setPrevModuleBusy(false));
  }, [sessionId]);

  // US-6.16 КП-1 ("Пояснити"): the quick tutor_chat path (D-77), not the
  // heavy planning/generation/review pipeline — posts straight into the chat
  // panel and opens it, same as the design's "публікує пояснення в чат".
  const navExplain = useCallback(() => {
    touch();
    setExplainBusy(true);
    explainStepAction(sessionId, step.stepId, subjectId, topicId)
      .then((res) => {
        if (res.status === "ok") chatRef.current?.pushAndOpen(res.message.content);
      })
      .finally(() => setExplainBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, step.stepId, subjectId, topicId]);

  const changePresentationMode = useCallback(
    (mode: PresentationMode) => {
      setPresentationModeState(mode);
      setPresentationModeAction(sessionId, mode).catch(() => {});
    },
    [sessionId],
  );

  // Idle hint / auto-pause (US-16.4).
  useEffect(() => {
    const id = setInterval(() => {
      const idleSeconds = (Date.now() - lastInteractionRef.current) / 1000;
      if (idleSeconds >= idlePauseS) {
        clearInterval(id);
        pauseLessonAction(sessionId, "idle").finally(() => router.refresh());
        return;
      }
      if (idleSeconds >= idleHintS) setShowIdleHint(true);
    }, 2000);
    return () => clearInterval(id);
  }, [idleHintS, idlePauseS, sessionId, router]);

  // US-12.2 КП-1: a heartbeat every 20 s of continuous, non-idle work — the
  // server decides when the break threshold is reached (`tickLessonActivity`).
  useEffect(() => {
    const HEARTBEAT_S = 20;
    const id = setInterval(() => {
      const idleSeconds = (Date.now() - lastInteractionRef.current) / 1000;
      if (idleSeconds >= idleHintS || offline) return; // not "continuous work" right now.
      tickLessonActivityAction(sessionId, HEARTBEAT_S)
        .then((r) => {
          if (r.breakOffer) setBreakOffer(true);
        })
        .catch(() => {});
    }, HEARTBEAT_S * 1000);
    return () => clearInterval(id);
  }, [sessionId, idleHintS, offline]);

  // Offline banner (US-6.5): pause is recorded, but the screen stays put —
  // "Немає зв'язку, усе збережено" — until the connection returns.
  // BUG-007: flush the offline queue on mount and whenever the browser
  // reports "online" — never only on an explicit retry tap, so a resumed
  // connection resends automatically, with no action from the child.
  const flushQueue = useCallback(async () => {
    const all = await listQueuedAnswers();
    const mine = all.filter((q) => q.sessionId === sessionId);
    if (mine.length === 0) return;
    await resendQueued(mine, async (entry: QueuedAnswer) => {
      const result = await submitStepAnswerAction(entry.sessionId, entry.stepId, entry.idempotencyKey, {
        channel: entry.channel,
        answer: entry.answer,
        latencyMs: entry.latencyMs,
      });
      await dequeueAnswer(entry.idempotencyKey);
      if (entry.stepId === step.stepId) {
        setQueuedAnswer(null);
        applyAnswerResult(result);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, step.stepId]);

  useEffect(() => {
    flushQueue();
    window.addEventListener("online", flushQueue);
    return () => window.removeEventListener("online", flushQueue);
  }, [flushQueue]);

  useEffect(() => {
    const onOffline = () => {
      setOffline(true);
      pauseLessonAction(sessionId, "network").catch(() => {});
    };
    const onOnline = () => {
      setOffline(false);
      flushQueue();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [sessionId, flushQueue]);

  function goToNext(next: NextView) {
    if (next.kind === "advance" && next.step) {
      setStep(next.step);
      setStepStartedAt(Date.now());
      setFeedback(null);
      setFormatOffer(false);
      setOpenAnswer("");
      setQueuedAnswer(null);
    } else if (next.kind === "block_complete") {
      setBlockComplete({ libraryItemId: next.libraryItemId, visibleOutcomeUk: next.visibleOutcomeUk });
    } else if (next.kind === "lesson_complete") {
      router.refresh();
    }
    // "retry_step": stays on the same step, feedback already shown.
  }

  function applyAnswerResult(result: AnswerResultView) {
    // BUG-019: `partial` and `incorrect` used to share the same "Майже!"
    // text, which is exactly why a genuinely wrong answer read the same as
    // a real "close, try again" — this made a evaluator bug (BUG-019) look
    // like ordinary feedback instead of a wrong verdict. Each verdict now
    // gets its own wording.
    const headline = result.verdict === "correct" ? t.correct : result.verdict === "partial" ? t.almost : t.incorrect;
    setFeedback({ correct: result.verdict === "correct", text: `${headline}${result.explanation ? ` — ${result.explanation}` : ""}` });
    if (result.formatChangeSuggested) setFormatOffer(true);
    if (result.next.kind !== "retry_step") goToNext(result.next);
  }

  async function submit(channel: "choice" | "text" | "voice" | "photo", answer: unknown) {
    touch();
    setBusy(true);
    setQueuedAnswer({ channel, answer });
    const idempotencyKey = crypto.randomUUID();
    const latencyMs = Date.now() - stepStartedAt;
    // BUG-012: `submitAnswerOffline` writes the answer to the offline queue
    // BEFORE the network call, not only in a `catch` after it — a request
    // that hangs (degrading mobile connection) rather than rejecting
    // immediately, followed by the tab closing mid-flight, would otherwise
    // lose the answer the same way BUG-007 did. It is removed from the
    // queue only once `submitStepAnswerAction` has confirmed success; on any
    // failure it stays queued and `flushQueue` (mount / "online") resends it
    // automatically, without her retyping or repicking anything.
    await submitAnswerOffline({ idempotencyKey, sessionId, stepId: step.stepId, channel, answer, latencyMs, queuedAt: Date.now() }, async (entry) => {
      const result = await submitStepAnswerAction(entry.sessionId, entry.stepId, entry.idempotencyKey, {
        channel: entry.channel,
        answer: entry.answer,
        latencyMs: entry.latencyMs,
      });
      setQueuedAnswer(null);
      applyAnswerResult(result);
    });
    setBusy(false);
  }

  async function acknowledgeSlide() {
    touch();
    setBusy(true);
    try {
      const next = await acknowledgeSlideAction(sessionId, step.stepId);
      goToNext(next);
    } catch {
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (breakOffer) {
    return (
      <BreakOfferScreen
        labels={t}
        busy={busy}
        onTakeBreak={() => {
          setBusy(true);
          takeLessonBreakAction(sessionId)
            .then(() => router.refresh())
            .finally(() => setBusy(false));
        }}
        onSkip={() => {
          setBusy(true);
          skipLessonBreakAction(sessionId)
            .then(() => setBreakOffer(false))
            .finally(() => setBusy(false));
        }}
      />
    );
  }

  if (blockComplete) {
    return (
      <BlockCompleteScreen
        libraryItemId={blockComplete.libraryItemId}
        visibleOutcomeUk={blockComplete.visibleOutcomeUk}
        labels={t}
        onContinue={() => {
          setBusy(true);
          continueAfterBlockAction(sessionId)
            .then((next) => {
              setBlockComplete(null);
              goToNext(next);
            })
            .catch(() => router.refresh())
            .finally(() => setBusy(false));
        }}
      />
    );
  }

  return (
    <div onPointerDown={touch} onKeyDown={touch} className="px-6 pt-4">
      {queuedAnswer && (
        <div className="mb-3 rounded-2xl bg-warn/20 px-4 py-2.5 text-sm font-bold" role="status">
          {t.queuedOffline}
        </div>
      )}
      {offline && (
        <div className="mb-3 rounded-2xl bg-warn/20 px-4 py-2.5 text-sm font-bold" role="status">
          {t.offlineBanner}
        </div>
      )}
      {showIdleHint && !offline && (
        <div className="mb-3 rounded-2xl bg-surface-alt px-4 py-2.5 text-sm font-bold" role="status">
          {t.idleHint}
        </div>
      )}

      {/* US-6.16 (docs/04 §5.2, §11.4): speech-mode switch, always visible,
          text label on every segment (not icon-only) — never lower than the
          progress row so it reads before the nav rail below it. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold text-muted">{t.stepOf(step.stepNumber, step.totalSteps)}</span>
        <div role="group" aria-label={t.speechModeCaption} className="flex items-center gap-1 rounded-full bg-surface-alt p-1">
          <span className="hidden pl-2 text-xs font-bold text-muted sm:inline">{t.speechModeCaption}</span>
          {(
            [
              ["voice", "🔊", t.speechModeVoice],
              ["auto", "🤖", t.speechModeAuto],
              ["text", "🔤", t.speechModeText],
            ] as const
          ).map(([mode, icon, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => changePresentationMode(mode)}
              aria-pressed={presentationMode === mode}
              className={`min-h-11 rounded-full px-3 text-xs font-extrabold ${presentationMode === mode ? "bg-accent text-white" : "text-muted"}`}
            >
              {icon} {label}
            </button>
          ))}
        </div>
      </div>

      {presentationMode === "voice" && (
        <div className="mb-3 rounded-2xl border border-accent bg-accent/10 px-4 py-2.5 text-sm font-bold" role="status">
          🎧 {t.audiobookBanner}
        </div>
      )}
      {presentationMode === "text" && (
        <div className="mb-3 rounded-2xl bg-surface-alt px-4 py-2.5 text-sm font-bold" role="status">
          🔤 {t.textModeBanner}
        </div>
      )}

      <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface-alt">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(step.stepNumber / step.totalSteps) * 100}%` }} />
      </div>

      {/* US-6.16 КП-1…КП-4/КП-7: navigation rail (docs/04 §11.4) — "Перейти"
          group, then the pre-existing "Безпека" group (BUG-020/026) kept
          exactly as it was, visually separated. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={navHome} disabled={busy} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-60">
          {t.navHome}
        </button>
        <button type="button" onClick={navSubjectList} disabled={busy} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-60">
          {t.navSubjectList}
        </button>
        {/* КП-2: hidden on the very first block — nothing to go back to. */}
        {step.stepNumber >= 1 && (
          <button
            type="button"
            onClick={navPrevModule}
            disabled={prevModuleBusy}
            className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-60"
          >
            {t.navPrevModule}
          </button>
        )}
        <button
          type="button"
          onClick={navExplain}
          disabled={explainBusy}
          className="min-h-11 rounded-full border-2 border-accent bg-accent/10 px-3.5 text-sm font-bold text-accent disabled:opacity-60"
        >
          {explainBusy ? t.explainSending : t.navExplain}
        </button>

        <span className="flex-1" />

        {/* BUG-026: the previous style (`border-line` + `text-muted`) was the
            same visual weight as an inactive/secondary element, so it read
            as unclickable next to the bright red "Тривога" — a contrastier
            but still non-alarming secondary style, not a full ghost/primary
            button, so it doesn't compete with "Тривога" for attention. */}
        <button
          type="button"
          onClick={() => setExitConfirmOpen(true)}
          className="min-h-11 rounded-full border-2 border-text/40 bg-surface-alt px-4 text-sm font-bold text-text"
        >
          {t.exitLesson}
        </button>
        <button type="button" onClick={alarm} className="min-h-11 rounded-full bg-danger px-4 text-sm font-bold text-white">
          {t.alarmButton}
        </button>
      </div>

      {prevModule && (
        <PreviousModuleModal view={prevModule} labels={t} onClose={() => setPrevModule(null)} />
      )}

      {presentationMode === "voice" && (
        <NarrationPlayer key={step.stepId} sessionId={sessionId} stepId={step.stepId} labels={t} />
      )}

      {exitConfirmOpen && (
        <div className="mb-4 rounded-2xl border border-line bg-surface-alt p-3.5" role="alertdialog" aria-label={t.exitLessonConfirmTitle}>
          <p className="mb-1 text-sm font-bold">{t.exitLessonConfirmTitle}</p>
          <p className="mb-2.5 text-sm text-muted">{t.exitLessonConfirmBody}</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={exitLesson} className="rounded-xl bg-danger px-3 py-2 text-sm font-bold text-white disabled:opacity-60">
              {t.exitLessonConfirmYes}
            </button>
            <button type="button" onClick={() => setExitConfirmOpen(false)} className="rounded-xl bg-primary px-3 py-2 text-sm font-bold text-white">
              {t.exitLessonConfirmNo}
            </button>
          </div>
        </div>
      )}

      <StepBody
        step={step}
        busy={busy}
        openAnswer={openAnswer}
        setOpenAnswer={setOpenAnswer}
        onChoice={(optionId) => submit("choice", { optionId })}
        onOpenSubmit={() => submit("text", { text: openAnswer })}
        // BUG-019 (regression root cause for interactive steps, e.g.
        // `drag_sort`): this used to send `{ component, answer, correct }` —
        // the server's `evaluateAnswer` for type "interactive" expects the
        // raw answer shape only (`def.evaluate(props, answer)`), so every
        // submission was graded against the wrong shape and came back
        // `incorrect` regardless of what the child actually placed. The
        // client-computed `correct` was never trusted anyway — the server
        // re-grades deterministically off the same `props` (ADR-020 §1) —
        // so it is simply dropped here, not forwarded.
        onInteractiveSubmit={(answer) => submit("text", answer)}
        onSlideNext={acknowledgeSlide}
        labels={t}
      />

      {step.sourceRefs.length > 0 && (
        <p className="mt-4 text-xs text-muted">
          {step.sourceRefs.map((r) => t.sourceRef(r.materialTitle, r.page)).join(" · ")}
        </p>
      )}

      {feedback && (
        <p className={`mt-4 text-base font-bold ${feedback.correct ? "text-secondary" : "text-warn"}`} role="status">
          {feedback.text}
        </p>
      )}

      {formatOffer && (
        <div className="mt-4 rounded-2xl border border-line bg-surface-alt p-3.5">
          <p className="mb-2 text-sm font-bold">{t.formatChangeOffer}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setFormatOffer(false)} className="rounded-xl bg-primary px-3 py-2 text-sm font-bold text-white">
              {t.keepGoing}
            </button>
          </div>
        </div>
      )}

      <TopicChat ref={chatRef} sessionId={sessionId} subjectId={subjectId} topicId={topicId} labels={t} />
    </div>
  );
}

function StepBody({
  step,
  busy,
  openAnswer,
  setOpenAnswer,
  onChoice,
  onOpenSubmit,
  onInteractiveSubmit,
  onSlideNext,
  labels: t,
}: {
  step: StepView;
  busy: boolean;
  openAnswer: string;
  setOpenAnswer: (v: string) => void;
  onChoice: (optionId: string) => void;
  onOpenSubmit: () => void;
  onInteractiveSubmit: (answer: Record<string, string>, correct: boolean) => void;
  onSlideNext: () => void;
  labels: Labels;
}) {
  if (step.type === "slide") {
    return (
      <div className="rounded-[22px] border border-line bg-surface p-4.5">
        <p className="mb-3 whitespace-pre-line text-lg">{String(step.content.textUk ?? "")}</p>
        {!!step.content.exampleUk && <p className="mb-3 rounded-xl bg-surface-alt p-3 text-sm">{String(step.content.exampleUk)}</p>}
        <button type="button" disabled={busy} onClick={onSlideNext} className="mt-2 inline-flex min-h-12 items-center justify-center rounded-2xl bg-primary px-5 text-base font-bold text-white">
          {t.nextStep}
        </button>
      </div>
    );
  }
  if (step.type === "choice") {
    const options = (step.content.options as { id: string; textUk: string }[]) ?? [];
    return (
      <div className="rounded-[22px] border border-line bg-surface p-4.5">
        <p className="mb-3.5 text-lg font-bold">{String(step.content.questionUk ?? "")}</p>
        <div className="grid gap-2.5">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={busy}
              onClick={() => onChoice(o.id)}
              className="min-h-12 rounded-2xl border-2 border-line bg-bg px-4 py-3 text-left text-base font-semibold active:scale-[0.98]"
            >
              {o.textUk}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (step.type === "open") {
    return (
      <div className="rounded-[22px] border border-line bg-surface p-4.5">
        <p className="mb-3.5 text-lg font-bold">{String(step.content.questionUk ?? "")}</p>
        <textarea
          value={openAnswer}
          onChange={(e) => setOpenAnswer(e.target.value)}
          placeholder={t.openAnswerPlaceholder}
          rows={3}
          className="w-full rounded-2xl border-2 border-line bg-bg px-4 py-3 text-base outline-none focus:border-focus"
        />
        <button
          type="button"
          disabled={busy || openAnswer.trim().length === 0}
          onClick={onOpenSubmit}
          className="mt-3 inline-flex min-h-12 items-center justify-center rounded-2xl bg-primary px-5 text-base font-bold text-white disabled:opacity-60"
        >
          {t.submitAnswer}
        </button>
      </div>
    );
  }
  if (step.type === "interactive" && step.visual.component === "drag_sort") {
    return <DragSortStep props={step.visual.props as DragSortProps} onSubmit={onInteractiveSubmit} />;
  }
  return null;
}

export interface TopicChatHandle {
  /** US-6.16 КП-1: "Пояснити" publishes straight into this chat and opens it. */
  pushAndOpen(content: string): void;
}

const TopicChat = forwardRef<TopicChatHandle, { sessionId: string; subjectId: string; topicId: string; labels: Labels }>(function TopicChat(
  { sessionId, subjectId, topicId, labels: t },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ author: string; content: string }[]>([]);
  const [pending, setPending] = useState(false);

  useImperativeHandle(ref, () => ({
    pushAndOpen(content: string) {
      setMessages((prev) => [...prev, { author: "ai", content }]);
      setOpen(true);
    },
  }));

  async function send() {
    const q = question.trim();
    if (!q) return;
    setMessages((prev) => [...prev, { author: "child", content: q }]);
    setQuestion("");
    setPending(true);
    try {
      const res = await askTopicChatAction(sessionId, subjectId, topicId, q);
      if (res.status === "ok") setMessages((prev) => [...prev, { author: "ai", content: res.message.content }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-6">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm font-bold text-muted underline">
        {t.chatTitle}
      </button>
      {open && (
        <div className="mt-2 rounded-2xl border border-line bg-surface p-3.5">
          <div className="mb-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto text-sm">
            {messages.map((m, i) => (
              <p key={i} className={m.author === "child" ? "font-bold" : "text-muted"}>
                {m.content}
              </p>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={t.chatPlaceholder}
              className="min-h-12 flex-1 rounded-2xl border-2 border-line bg-bg px-3.5 text-sm outline-none focus:border-focus"
            />
            <button type="button" disabled={pending} onClick={send} className="rounded-2xl bg-primary px-4 text-sm font-bold text-white">
              {t.chatSend}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

/** US-6.16 КП-2: read-only preview of the previously completed block — no grading, no AI call. */
function PreviousModuleModal({
  view,
  labels: t,
  onClose,
}: {
  view: { title: string; steps: { type: string; content: Record<string, unknown> }[] };
  labels: Labels;
  onClose: () => void;
}) {
  return (
    <div className="mb-4 rounded-[22px] border-2 border-dashed border-secondary bg-surface p-4.5" role="dialog" aria-label={t.prevModuleTitle}>
      <p className="mb-1 text-sm font-extrabold text-secondary">{t.prevModuleTitle}</p>
      <p className="mb-3 text-xs text-muted">{t.prevModuleBody}</p>
      <h3 className="mb-2 text-lg font-extrabold">{view.title}</h3>
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
        {view.steps.map((s, i) => (
          <div key={i} className="rounded-2xl bg-surface-alt p-3 text-sm">
            {!!s.content.textUk && <p className="whitespace-pre-line">{String(s.content.textUk)}</p>}
            {!!s.content.questionUk && <p className="font-bold">{String(s.content.questionUk)}</p>}
          </div>
        ))}
      </div>
      <button type="button" onClick={onClose} className="mt-3 inline-flex min-h-11 items-center justify-center rounded-2xl bg-primary px-5 text-sm font-bold text-white">
        {t.prevModuleClose}
      </button>
    </div>
  );
}

/**
 * US-6.16 КП-5 (режим «Вголос», ADR-025): fetches and autoplays narration for
 * the current step; failure/unavailable is silent (docs/04 §5) — the step's
 * own text is already on screen either way.
 */
function NarrationPlayer({ sessionId, stepId, labels: t }: { sessionId: string; stepId: string; labels: Labels }) {
  // The parent renders this with `key={step.stepId}` (a fresh mount, and so
  // a fresh `useState`/`useEffect`, per step) — no in-place reset is needed
  // here for a step change.
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let cancelled = false;
    synthesizeNarrationAction(sessionId, stepId).then((res) => {
      if (cancelled) return;
      if (res.status === "ok") setAudioUrl(`data:${res.mimeType};base64,${res.audioBase64}`);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, stepId]);

  if (!audioUrl) return null;
  return (
    <div className="mb-4 flex items-center gap-2">
      <audio ref={audioRef} src={audioUrl} autoPlay controls className="h-10 flex-1" />
      <button
        type="button"
        onClick={() => audioRef.current?.play()}
        className="min-h-11 rounded-full border-2 border-line bg-surface px-3 text-sm font-bold"
      >
        {t.narrationReplay}
      </button>
    </div>
  );
}

/**
 * US-6.13: shown between blocks — the concrete "тепер ти вмієш…" result
 * (КП-1/2), plus an optional one-tap feedback (КП-3) that never affects
 * points. "Далі" is the only way forward — never an auto-advance.
 */
/** US-12.2 КП-1: "Перерва" or "Продовжити без перерви" — either way the child decides. */
function BreakOfferScreen({
  labels: t,
  busy,
  onTakeBreak,
  onSkip,
}: {
  labels: Labels;
  busy: boolean;
  onTakeBreak: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="rounded-[22px] border border-line bg-surface p-5 text-center">
        <h2 className="mb-2 text-xl font-extrabold">{t.breakOfferTitle}</h2>
        <p className="mb-5 text-base text-muted">{t.breakOfferBody}</p>
        <div className="flex flex-col gap-2.5">
          <button type="button" disabled={busy} onClick={onTakeBreak} className="min-h-12 rounded-2xl bg-primary px-5 text-base font-bold text-white">
            {t.takeBreak}
          </button>
          <button type="button" disabled={busy} onClick={onSkip} className="min-h-12 rounded-2xl border-2 border-line bg-bg px-5 text-base font-bold">
            {t.skipBreak}
          </button>
        </div>
      </div>
    </div>
  );
}

function BlockCompleteScreen({
  libraryItemId,
  visibleOutcomeUk,
  labels: t,
  onContinue,
}: {
  libraryItemId: string;
  visibleOutcomeUk: string | null;
  labels: Labels;
  onContinue: () => void;
}) {
  const [feedbackSent, setFeedbackSent] = useState<"interesting" | "normal" | "boring" | null>(null);

  function sendFeedback(kind: "interesting" | "normal" | "boring") {
    setFeedbackSent(kind);
    if (libraryItemId) submitBlockFeedbackAction(libraryItemId, kind).catch(() => {});
  }

  return (
    <div className="px-6 pt-4">
      <div className="rounded-[22px] border border-line bg-surface p-4.5">
        <h2 className="mb-2 text-xl font-extrabold">{t.blockDoneTitle}</h2>
        {visibleOutcomeUk && <p className="mb-4 text-lg font-bold text-secondary">{visibleOutcomeUk}</p>}

        <p className="mb-2 text-sm font-bold text-muted">{t.feedbackPrompt}</p>
        {feedbackSent ? (
          <p className="mb-4 text-sm font-semibold">{t.feedbackThanks}</p>
        ) : (
          <div className="mb-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => sendFeedback("interesting")} className="rounded-xl border-2 border-line bg-bg px-3 py-2 text-sm font-bold">
              {t.feedbackInteresting}
            </button>
            <button type="button" onClick={() => sendFeedback("normal")} className="rounded-xl border-2 border-line bg-bg px-3 py-2 text-sm font-bold">
              {t.feedbackNormal}
            </button>
            <button type="button" onClick={() => sendFeedback("boring")} className="rounded-xl border-2 border-line bg-bg px-3 py-2 text-sm font-bold">
              {t.feedbackBoring}
            </button>
          </div>
        )}

        <button type="button" onClick={onContinue} className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-primary px-5 text-base font-bold text-white">
          {t.blockContinue}
        </button>
      </div>
    </div>
  );
}
