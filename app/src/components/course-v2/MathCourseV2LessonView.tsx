"use client";

import { useRef, useState } from "react";
import { LessonNavBar } from "@/components/shared/LessonNavBar";
import { MathText } from "@/components/shared/MathText";
import {
  narrateMathCourseV2Action,
  revealExerciseSolutionAction,
  submitQuestionAnswerAction,
  type QuestionAnswerResult,
} from "@/app/actions/math-course-v2";
import type { MathV2ExerciseView, MathV2LessonView, MathV2QuestionView } from "@/server/lessons/mathCourseV2View";

/**
 * S35 — child-facing viewer for one `course_v2_lessons` row (Істер math6
 * part1 full-text package). Two things set this apart from S34's
 * `CourseLessonView.tsx`:
 *
 * 1. Screens are shown ONE AT A TIME with Назад/Далі (package contract:
 *    "подайте їх по одному") — not one long scroll.
 * 2. The test NEVER computes correctness client-side: it calls
 *    `submitQuestionAnswerAction` and only learns the correct option id
 *    from that action's response, after the child has already answered.
 *    This is the fix for the vulnerability documented in
 *    `CourseLessonView.tsx`'s `toLiteratureTestQuestions` (S33/S34) — kept
 *    deliberately un-refactored there (see handback report), but not
 *    repeated here.
 */

function ListenButton({ refTable, refId, field, text }: { refTable: string; refId: string; field: string; text: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "unavailable">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function play() {
    if (state === "loading") return;
    setState("loading");
    try {
      const res = await narrateMathCourseV2Action({ refTable, refId, field, text });
      if (res.status !== "ok") {
        setState("unavailable");
        return;
      }
      const audio = new Audio(`data:${res.audioMime};base64,${res.audioBase64}`);
      audioRef.current = audio;
      audio.onended = () => setState("idle");
      setState("playing");
      void audio.play().catch(() => setState("idle"));
    } catch {
      // A thrown request error must still leave the button clickable again
      // rather than stuck on "…" forever — same silent-lock class of bug as
      // `QuestionCard`/`ExerciseCard` above.
      setState("unavailable");
    }
  }

  if (!text.trim()) return null;
  return (
    <button
      type="button"
      onClick={play}
      disabled={state === "loading" || state === "playing"}
      className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60"
    >
      {state === "loading" ? "…" : state === "playing" ? "🔊 Грає…" : state === "unavailable" ? "🔇 Недоступно" : "🔊 Слухати"}
    </button>
  );
}

function ScreenNav({ lesson }: { lesson: MathV2LessonView }) {
  const [index, setIndex] = useState(0);
  const screen = lesson.screens[index];
  if (!screen) return <p className="course-note">Екранів ще немає.</p>;

  return (
    <section>
      <p className="course-eyebrow">
        Екран {index + 1} з {lesson.screens.length}
      </p>
      {screen.title && <h3>{screen.title}</h3>}
      <p style={{ whiteSpace: "pre-wrap" }}>
        <MathText text={screen.displayMd} />
      </p>
      <div className="mt-2">
        <ListenButton refTable="course_v2_screens" refId={screen.id} field="narration" text={screen.narration} />
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40">
          ← Назад
        </button>
        <button
          type="button"
          disabled={index >= lesson.screens.length - 1}
          onClick={() => setIndex((i) => Math.min(lesson.screens.length - 1, i + 1))}
          className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40"
        >
          Далі →
        </button>
      </div>
    </section>
  );
}

function QuestionCard({ question }: { question: MathV2QuestionView }) {
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
      <ListenButton refTable="course_v2_questions" refId={question.id} field="narration" text={question.narration} />
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

function ExerciseCard({ exercise }: { exercise: MathV2ExerciseView }) {
  const [revealed, setRevealed] = useState<{ hint: string; parts: { label: string; stepsMd: string[]; answerMd: string }[]; sourceIssueWarning: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const res = await revealExerciseSolutionAction({ exerciseId: exercise.id });
      if (res.status === "ok") setRevealed(res.result);
      else setError(res.message);
    } catch (e) {
      setError(`Не вдалося показати розв'язання (${(e as Error).message}). Спробуй ще раз.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="course-exercise-card">
      <p className="course-exercise-number">№ {exercise.originalNumber}</p>
      {exercise.hasConstructionTemplate && (
        <p className="course-warning">
          Цю вправу потрібно виконувати з роздрукованим рисунком у реальному масштабі (не вимірюй за екраном).
        </p>
      )}
      <p style={{ whiteSpace: "pre-wrap" }}>
        <MathText text={exercise.displayMd} />
      </p>
      {exercise.assets.map((a) =>
        a.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL
          <img key={a.assetKey} src={a.url} alt={a.alt} className="course-exercise-asset" style={{ maxWidth: "100%", height: "auto" }} />
        ) : null,
      )}
      <div className="mt-1 flex items-center gap-2">
        <ListenButton refTable="course_v2_exercises" refId={exercise.id} field="narration" text={exercise.narration} />
        {!revealed && (
          <button type="button" onClick={reveal} disabled={busy} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60">
            {busy ? "…" : "Показати розв'язання"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs font-bold text-danger">
          {error}
        </p>
      )}
      {revealed && (
        <div className="mt-2 rounded-xl border border-line bg-surface-alt p-2.5 text-sm">
          {revealed.sourceIssueWarning && <p className="course-warning">{revealed.sourceIssueWarning}</p>}
          {revealed.parts.map((p, i) => (
            <div key={i} className="mb-2">
              {p.label && <p className="font-bold">{p.label})</p>}
              <ul className="list-disc pl-5">
                {p.stepsMd.map((s, j) => (
                  <li key={j}>
                    <MathText text={s} />
                  </li>
                ))}
              </ul>
              <p className="font-bold">
                Відповідь: <MathText text={p.answerMd} />
              </p>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

const EXERCISES_PER_PAGE = 10;

/** PO feedback 2026-10-07: a lesson can have 90+ linked exercises — rendered
 * as one long scroll, this was exactly the "гортання 10 сторінок" problem
 * the nav bar/pagination work was meant to avoid, just for exercises
 * instead of textbook-page images this time. Same windowed-index pattern
 * as `ScreenNav` above. */
function ExerciseList({ exercises }: { exercises: MathV2ExerciseView[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(exercises.length / EXERCISES_PER_PAGE);
  const start = page * EXERCISES_PER_PAGE;
  const visible = exercises.slice(start, start + EXERCISES_PER_PAGE);

  return (
    <>
      <p className="course-eyebrow">
        Сторінка {page + 1} з {pageCount} (вправи {start + 1}–{Math.min(start + EXERCISES_PER_PAGE, exercises.length)} з {exercises.length})
      </p>
      <ol className="course-exercise-list" start={start + 1}>
        {visible.map((e) => (
          <ExerciseCard key={e.exerciseKey} exercise={e} />
        ))}
      </ol>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40">
          ← Назад
        </button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40"
        >
          Далі →
        </button>
      </div>
    </>
  );
}

const KIND_LABEL: Record<MathV2LessonView["kind"], string> = {
  lesson: "Параграф",
  review: "Повторення",
  assessment: "Самостійна/перевірочна робота",
};

export function MathCourseV2LessonScreen({ lesson }: { lesson: MathV2LessonView }) {
  return (
    <article className="course-lesson">
      <LessonNavBar subjectId={lesson.subjectId} />
      <header>
        <p className="course-eyebrow">
          {KIND_LABEL[lesson.kind]} · {lesson.packageTitle}
        </p>
        <h1>{lesson.title}</h1>
        {lesson.printedPageFrom != null && (
          <p className="course-pages">
            Підручник: с. {lesson.printedPageFrom}
            {lesson.printedPageTo != null && lesson.printedPageTo !== lesson.printedPageFrom ? `–${lesson.printedPageTo}` : ""}
          </p>
        )}
        {lesson.status === "needs_review" && <p className="course-warning">Цей урок ще потребує перевірки дорослого.</p>}
      </header>

      {lesson.objectives.length > 0 && (
        <section>
          <h2>Чого навчимось</h2>
          <ul>
            {lesson.objectives.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      )}

      <ScreenNav lesson={lesson} />

      {lesson.exercises.length > 0 && (
        <section>
          <h2>Вправи з підручника</h2>
          <ExerciseList exercises={lesson.exercises} />
        </section>
      )}

      {lesson.quizQuestions.length > 0 && (
        <section>
          <h2>{lesson.quizTitle ?? "Тест"}</h2>
          <ol className="lit-test-list">
            {lesson.quizQuestions.map((q) => (
              <QuestionCard key={q.id} question={q} />
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
