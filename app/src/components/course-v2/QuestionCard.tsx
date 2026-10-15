"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { MathText } from "@/components/shared/MathText";
import { submitQuestionAnswerAction, type QuestionAnswerResult } from "@/app/actions/math-course-v2";

/**
 * S45 (ADR-044 §3): extracted from `MathCourseV2LessonView.tsx` (S35,
 * unchanged behavior for math — no E2E behavior there was altered by this
 * move) so `LiteratureV3LessonView.tsx`'s `quiz` steps can reuse it
 * literally. This is possible with ZERO new quiz markup/logic because
 * `literature_v3` quizzes are persisted as plain `course_v2_questions` rows
 * (ADR-044 §1, `literatureV3Persist.ts`) — `submitQuestionAnswerAction`
 * (`app/actions/math-course-v2.ts`) already works for ANY `course_v2_questions`
 * row regardless of which parent table owns its lesson (it looks the
 * question up by id, scoped by family RLS, not by subject) — no action code
 * changes needed for this reuse either.
 */

export interface CourseV2QuestionOptionView {
  id: string;
  displayMd: string;
}

export interface CourseV2QuestionView {
  id: string;
  displayMd: string;
  narration: string;
  maxPoints: number;
  options: CourseV2QuestionOptionView[];
}

/** `listenButton` is a caller-supplied "🔊 Слухати" button for
 * `question.narration` — each caller narrates through its own action
 * (`narrateMathCourseV2Action`/the literature_v3 narrate action both target
 * the SAME `course_v2_questions` table, just via a different, format-scoped
 * server action), so this stays a render-prop rather than a hardcoded call here. */
export function QuestionCard({ question, listenButton }: { question: CourseV2QuestionView; listenButton?: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<QuestionAnswerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PO complaint 2026-10-07 ("тести не працюють, відповідь не можна
  // вибрати"): a failed submit (missing key on an older import, a dropped
  // request) used to fail completely silently — no error shown, and a
  // thrown exception (vs. a returned `{status:"error"}`) left `busy` stuck
  // `true` forever, so the child's next click did nothing at all. Both
  // paths now show a real message and let her try again.
  async function answer(optionId: string) {
    if (result || busy) return;
    setSelected(optionId);
    setBusy(true);
    setError(null);
    try {
      const res = await submitQuestionAnswerAction({ questionId: question.id, optionId });
      if (res.status === "ok") setResult(res.result);
      else setError(res.message);
    } catch (e) {
      setError(`Не вдалося перевірити відповідь (${(e as Error).message}). Спробуй ще раз.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="lit-test-q">
      <p className="lit-test-q-text">
        <MathText text={question.displayMd} />
      </p>
      {listenButton}
      <ul className="lit-test-options">
        {question.options.map((o) => {
          const isSelected = selected === o.id;
          const isCorrectRevealed = result && o.id === result.correctOptionId;
          const isWrongSelected = result && isSelected && !result.correct;
          return (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => answer(o.id)}
                disabled={!!result || busy}
                className={`min-h-11 w-full rounded-xl border-2 px-3.5 text-left text-sm font-semibold disabled:opacity-100 ${
                  isCorrectRevealed ? "border-success bg-success/10" : isWrongSelected ? "border-danger bg-danger/10" : "border-line bg-surface"
                }`}
              >
                <MathText text={o.displayMd} />
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-1 text-xs font-bold text-danger">
          {error}
        </p>
      )}
      {!result && !skipped && (
        <button type="button" onClick={() => setSkipped(true)} className="mt-1 text-xs font-bold text-text/60 underline">
          Пропустити (питання не буде зараховано)
        </button>
      )}
      {result && (
        <div className="mt-2 rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
          <p className="font-bold">{result.correct ? "Правильно!" : "Неправильно."}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>
            <MathText text={result.explanationMd} />
          </p>
          {!result.correct && result.hint && (
            <p className="mt-1 text-text/70">
              Підказка: <MathText text={result.hint} />
            </p>
          )}
        </div>
      )}
    </li>
  );
}
