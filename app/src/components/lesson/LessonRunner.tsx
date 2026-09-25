"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DragSortStep } from "@/lesson-components/drag_sort/DragSortStep";
import type { DragSortProps } from "@/lesson-components/drag_sort";
import type { uk } from "@/i18n/uk";
import {
  acknowledgeSlideAction,
  askTopicChatAction,
  continueAfterBlockAction,
  pauseLessonAction,
  submitBlockFeedbackAction,
  submitStepAnswerAction,
} from "@/app/actions/lesson";
import { dequeueAnswer, enqueueAnswer, listQueuedAnswers, resendQueued, type QueuedAnswer } from "./offlineQueue";

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
  labels: t,
}: {
  sessionId: string;
  subjectId: string;
  topicId: string;
  step: StepView;
  idleHintS: number;
  idlePauseS: number;
  labels: Labels;
}) {
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
    setFeedback({ correct: result.verdict === "correct", text: result.verdict === "correct" ? t.correct : `${t.almost}${result.explanation ? ` — ${result.explanation}` : ""}` });
    if (result.formatChangeSuggested) setFormatOffer(true);
    if (result.next.kind !== "retry_step") goToNext(result.next);
  }

  async function submit(channel: "choice" | "text" | "voice" | "photo", answer: unknown) {
    touch();
    setBusy(true);
    setQueuedAnswer({ channel, answer });
    const idempotencyKey = crypto.randomUUID();
    const latencyMs = Date.now() - stepStartedAt;
    try {
      const result = await submitStepAnswerAction(sessionId, step.stepId, idempotencyKey, { channel, answer, latencyMs });
      setQueuedAnswer(null);
      applyAnswerResult(result);
    } catch {
      // BUG-007: the answer she just gave is never lost — buffered on the
      // device (safe by `idempotencyKey`, unique on `step_attempts`) and
      // resent automatically once the connection returns (`flushQueue`
      // above), without her retyping or repicking anything.
      await enqueueAnswer({ idempotencyKey, sessionId, stepId: step.stepId, channel, answer, latencyMs, queuedAt: Date.now() });
    } finally {
      setBusy(false);
    }
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

      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-bold text-muted">{t.stepOf(step.stepNumber, step.totalSteps)}</span>
        <button type="button" onClick={alarm} className="rounded-full bg-danger px-4 py-2 text-sm font-bold text-white">
          {t.alarmButton}
        </button>
      </div>
      <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-surface-alt">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(step.stepNumber / step.totalSteps) * 100}%` }} />
      </div>

      <StepBody
        step={step}
        busy={busy}
        openAnswer={openAnswer}
        setOpenAnswer={setOpenAnswer}
        onChoice={(optionId) => submit("choice", { optionId })}
        onOpenSubmit={() => submit("text", { text: openAnswer })}
        onInteractiveSubmit={(answer, correct) => submit("text", { component: step.visual.component, answer, correct })}
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

      <TopicChat sessionId={sessionId} subjectId={subjectId} topicId={topicId} labels={t} />
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

function TopicChat({ sessionId, subjectId, topicId, labels: t }: { sessionId: string; subjectId: string; topicId: string; labels: Labels }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ author: string; content: string }[]>([]);
  const [pending, setPending] = useState(false);

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
}

/**
 * US-6.13: shown between blocks — the concrete "тепер ти вмієш…" result
 * (КП-1/2), plus an optional one-tap feedback (КП-3) that never affects
 * points. "Далі" is the only way forward — never an auto-advance.
 */
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
