"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { LessonNavBar } from "@/components/shared/LessonNavBar";
import { MathText } from "@/components/shared/MathText";
import { OpenTextbookPageButton } from "@/components/shared/BookPageModal";
import { askTopicChatAction } from "@/app/actions/lesson";
import {
  explainMathCourseV2Action,
  narrateMathCourseV2Action,
  revealExerciseSolutionAction,
  submitQuestionAnswerAction,
  type QuestionAnswerResult,
} from "@/app/actions/math-course-v2";
import type { MathV2ExerciseView, MathV2LessonView, MathV2QuestionView } from "@/server/lessons/mathCourseV2View";

const VOICE_MODE_STORAGE_KEY = "mathCourseV2VoiceMode";

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

function ListenButton({ refTable, refId, field, text, autoPlay }: { refTable: string; refId: string; field: string; text: string; autoPlay?: boolean }) {
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

  // PO complaint 2026-10-07: "озвучка на кожному екрані переривається, тобто
  // я маю вмикати голосовий режим щоразу" — narration used to need a manual
  // click on every single screen. The parent mounts this with a fresh `key`
  // per screen/exercise/question (see `ScreenNav` below), so this effect
  // firing once on mount is exactly "narrate the thing I was just shown",
  // not a loop. `play()`'s first line calls `setState` — deferred into a
  // microtask (same pattern as `LessonRunner.tsx`'s `NarrationPlayer`) so it
  // isn't a direct synchronous setState-in-effect.
  useEffect(() => {
    if (!autoPlay || !text.trim()) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) void play();
    });
    return () => {
      cancelled = true;
    };
    // Intentionally only on mount (fresh per screen/exercise/question via
    // the caller's `key`) — not on every `text`/`autoPlay` change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

/**
 * PO request 2026-10-07: "кнопка пояснити біля завдання або теми уроку —
 * ШІ має прочитати та пояснити більш розширено". One click, no typing: asks
 * `explainMathCourseV2Action` (same paid `tutor_chat` role as the chat
 * panel) and pushes the answer straight into the shared tutor-chat, opening
 * it — same `pushAndOpen` idea as `LessonRunner.tsx`'s own "💡 Пояснити".
 * Voice playback of the explanation is a planned follow-up (PO: "потім
 * прикрутимо мікрофон і... голосом"), not this slice.
 */
function ExplainButton({
  subjectId,
  topicId,
  stepText,
  chatRef,
}: {
  subjectId: string;
  topicId: string | null;
  stepText: string;
  chatRef: RefObject<LessonTopicChatHandle | null>;
}) {
  const [pending, setPending] = useState(false);
  if (!topicId || !stepText.trim()) return null;

  async function explain() {
    if (pending) return;
    setPending(true);
    try {
      const res = await explainMathCourseV2Action({ subjectId, topicId: topicId!, stepText });
      chatRef.current?.pushAndOpen(res.status === "ok" ? res.content : res.message);
    } catch (e) {
      chatRef.current?.pushAndOpen(`Не вдалося пояснити (${(e as Error).message}). Спробуй ще раз.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <button type="button" onClick={() => void explain()} disabled={pending} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60">
      {pending ? "…" : "💡 Пояснити"}
    </button>
  );
}

function ScreenNav({ lesson, voiceMode, chatRef }: { lesson: MathV2LessonView; voiceMode: boolean; chatRef: RefObject<LessonTopicChatHandle | null> }) {
  const [index, setIndex] = useState(0);
  const screen = lesson.screens[index];
  if (!screen) return <p className="course-note">Екранів ще немає.</p>;

  return (
    <section>
      {screen.title && <h3>{screen.title}</h3>}
      <p style={{ whiteSpace: "pre-wrap" }}>
        <MathText text={screen.displayMd} />
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ListenButton key={screen.id} refTable="course_v2_screens" refId={screen.id} field="narration" text={screen.narration} autoPlay={voiceMode} />
        <ExplainButton subjectId={lesson.subjectId} topicId={lesson.topicId} stepText={screen.displayMd} chatRef={chatRef} />
      </div>
      {/* PO feedback 2026-10-07: "надпис екран х з у краще показувати біля
          кнопок навігації" — moved from above the content down to right
          next to Назад/Далі, where it reads as part of the nav control. */}
      <p className="course-eyebrow mt-3">
        Екран {index + 1} з {lesson.screens.length}
      </p>
      <div className="mt-1 flex gap-2">
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

/** PO complaint 2026-10-07: narration needed a manual click on every screen.
 * A simple persisted (per-device, `localStorage`) toggle: while on, every
 * freshly-mounted `ListenButton` on a lesson screen auto-plays once. */
function VoiceModeToggle({ voiceMode, onChange }: { voiceMode: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!voiceMode)}
      aria-pressed={voiceMode}
      className={`min-h-11 rounded-full border-2 px-3.5 text-sm font-bold ${voiceMode ? "border-primary bg-primary/10 text-primary" : "border-line bg-surface"}`}
    >
      {voiceMode ? "🔊 Голосовий режим: увімкнено" : "🔈 Голосовий режим: вимкнено"}
    </button>
  );
}

/** PO complaint 2026-10-07: "у нас зник ШІ діалог... не можу попросити
 * пояснити завдання чи задачу". Reuses the EXISTING paid tutor-chat path
 * (`askTopicChatAction` — same role/cost as every other topic chat in the
 * app, nothing new) rather than building a parallel chat system; it only
 * needs a topic, no `lesson_sessions` row (its `sessionId` param is already
 * optional — used solely for moderation-event context). */
export interface LessonTopicChatHandle {
  /** PO request 2026-10-07: "💡 Пояснити" next to a screen/exercise pushes
   * the AI's explanation straight into this shared chat panel and opens it
   * — same `pushAndOpen` pattern as the old `LessonRunner.tsx`'s `TopicChat`. */
  pushAndOpen(content: string): void;
}

const LessonTopicChat = forwardRef<LessonTopicChatHandle, { subjectId: string; topicId: string }>(function LessonTopicChat({ subjectId, topicId }, ref) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ author: "child" | "ai"; content: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    pushAndOpen(content: string) {
      setMessages((prev) => [...prev, { author: "ai", content }]);
      setOpen(true);
    },
  }));

  async function send() {
    const q = question.trim();
    if (!q || pending) return;
    setMessages((prev) => [...prev, { author: "child", content: q }]);
    setQuestion("");
    setPending(true);
    setError(null);
    try {
      const res = await askTopicChatAction(null, subjectId, topicId, q);
      if (res.status === "ok") setMessages((prev) => [...prev, { author: "ai", content: res.message.content }]);
      else setError("Не вдалося надіслати запитання. Спробуй ще раз.");
    } catch (e) {
      setError(`Не вдалося надіслати запитання (${(e as Error).message}). Спробуй ще раз.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-6">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm font-bold text-muted underline">
        💬 Запитати репетитора про цю тему
      </button>
      {open && (
        <div className="mt-2 rounded-2xl border border-line bg-surface p-3.5">
          {messages.length > 0 && (
            <div className="mb-2 flex max-h-40 flex-col gap-1.5 overflow-y-auto text-sm">
              {messages.map((m, i) => (
                <p key={i} className={m.author === "child" ? "font-bold" : "text-muted"}>
                  <MathText text={m.content} />
                </p>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              placeholder="Поясни цю задачу…"
              disabled={pending}
              className="min-h-11 flex-1 rounded-xl border-2 border-line bg-surface px-3 text-sm"
            />
            <button type="button" onClick={() => void send()} disabled={pending || !question.trim()} className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-60">
              {pending ? "…" : "Надіслати"}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-1.5 text-xs font-bold text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
});

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

interface TextbookRef {
  materialId: string;
  title: string;
  pageCount: number | null;
}

function ExerciseCard({
  exercise,
  textbook,
  subjectId,
  topicId,
  chatRef,
}: {
  exercise: MathV2ExerciseView;
  textbook: TextbookRef | null;
  subjectId: string;
  topicId: string | null;
  chatRef: RefObject<LessonTopicChatHandle | null>;
}) {
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
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <ListenButton refTable="course_v2_exercises" refId={exercise.id} field="narration" text={exercise.narration} />
        <ExplainButton subjectId={subjectId} topicId={topicId} stepText={exercise.displayMd} chatRef={chatRef} />
        {!revealed && (
          <button type="button" onClick={reveal} disabled={busy} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60">
            {busy ? "…" : "Показати розв'язання"}
          </button>
        )}
        {textbook && (
          <OpenTextbookPageButton materialId={textbook.materialId} title={textbook.title} pageCount={textbook.pageCount} page={exercise.printedPage} numberKeywordHint="вправа" />
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
function ExerciseList({
  exercises,
  textbook,
  subjectId,
  topicId,
  chatRef,
}: {
  exercises: MathV2ExerciseView[];
  textbook: TextbookRef | null;
  subjectId: string;
  topicId: string | null;
  chatRef: RefObject<LessonTopicChatHandle | null>;
}) {
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
          <ExerciseCard key={e.exerciseKey} exercise={e} textbook={textbook} subjectId={subjectId} topicId={topicId} chatRef={chatRef} />
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

function readStoredVoiceMode(): boolean {
  try {
    return window.localStorage.getItem(VOICE_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function MathCourseV2LessonScreen({ lesson }: { lesson: MathV2LessonView }) {
  const chatRef = useRef<LessonTopicChatHandle>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  // Lazy-read from localStorage only after mount (avoids a server/client
  // render mismatch — `window` doesn't exist during SSR). Deferred into a
  // microtask, same reasoning as `ListenButton`'s autoplay effect above.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setVoiceMode(readStoredVoiceMode());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function changeVoiceMode(v: boolean) {
    setVoiceMode(v);
    try {
      window.localStorage.setItem(VOICE_MODE_STORAGE_KEY, v ? "1" : "0");
    } catch {
      // per-device convenience only — fine to drop silently
    }
  }

  const textbook: TextbookRef | null = lesson.textbookMaterialId
    ? { materialId: lesson.textbookMaterialId, title: lesson.textbookTitle ?? lesson.packageTitle, pageCount: lesson.textbookPageCount }
    : null;

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
        <div className="mt-2 flex flex-wrap gap-2">
          <VoiceModeToggle voiceMode={voiceMode} onChange={changeVoiceMode} />
          {textbook && (
            <OpenTextbookPageButton
              materialId={textbook.materialId}
              title={textbook.title}
              pageCount={textbook.pageCount}
              page={lesson.printedPageFrom}
              label="📖 Відкрити підручник"
              numberKeywordHint="вправа"
            />
          )}
        </div>
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

      <ScreenNav lesson={lesson} voiceMode={voiceMode} chatRef={chatRef} />

      {lesson.topicId && <LessonTopicChat ref={chatRef} subjectId={lesson.subjectId} topicId={lesson.topicId} />}

      {lesson.exercises.length > 0 && (
        <section>
          <h2>Вправи з підручника</h2>
          <ExerciseList exercises={lesson.exercises} textbook={textbook} subjectId={lesson.subjectId} topicId={lesson.topicId} chatRef={chatRef} />
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
