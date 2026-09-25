"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DragSortStep } from "@/lesson-components/drag_sort/DragSortStep";
import type { DragSortProps } from "@/lesson-components/drag_sort";
import type { uk } from "@/i18n/uk";
import { acknowledgeSlideAction, askTopicChatAction, pauseLessonAction, submitStepAnswerAction } from "@/app/actions/lesson";

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
  useEffect(() => {
    const onOffline = () => {
      setOffline(true);
      pauseLessonAction(sessionId, "network").catch(() => {});
    };
    const onOnline = () => setOffline(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [sessionId]);

  function goToNext(next: { kind: string; step?: StepView | null }) {
    if (next.kind === "advance" && next.step) {
      setStep(next.step);
      setStepStartedAt(Date.now());
      setFeedback(null);
      setFormatOffer(false);
      setOpenAnswer("");
    } else if (next.kind === "lesson_complete") {
      router.refresh();
    }
    // "retry_step": stays on the same step, feedback already shown.
  }

  async function submit(channel: "choice" | "text" | "voice" | "photo", answer: unknown) {
    touch();
    setBusy(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const latencyMs = Date.now() - stepStartedAt;
      const result = await submitStepAnswerAction(sessionId, step.stepId, idempotencyKey, { channel, answer, latencyMs });
      setFeedback({ correct: result.verdict === "correct", text: result.verdict === "correct" ? t.correct : `${t.almost}${result.explanation ? ` — ${result.explanation}` : ""}` });
      if (result.formatChangeSuggested) setFormatOffer(true);
      if (result.next.kind !== "retry_step") goToNext(result.next);
    } catch {
      router.refresh();
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

  return (
    <div onPointerDown={touch} onKeyDown={touch} className="px-6 pt-4">
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
