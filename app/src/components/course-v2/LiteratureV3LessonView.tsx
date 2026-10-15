"use client";

import { useEffect, useRef, useState } from "react";
import { LessonNavBar } from "@/components/shared/LessonNavBar";
import { isCurrentlyPlaying, playSingleAudio, stopCurrentlyPlaying } from "@/components/shared/singleAudioPlayback";
import { narrateLiteratureV3Action } from "@/app/actions/literature-v3";
import { QuestionCard } from "@/components/course-v2/QuestionCard";
import type { LiteratureV3FlowStep, LiteratureV3LessonListItem, LiteratureV3LessonView as LiteratureV3LessonViewModel } from "@/server/lessons/literatureV3View";

/**
 * S45 (ADR-044 §3) — new child-facing viewer for one imported
 * `literature_v3_lessons` row ("Українська література" v2.0.0
 * chapter-package: `flow[]` of screen/biography/reading/quiz steps). NOT an
 * extension of `LiteratureV2LessonView.tsx` — see ADR-044 §3 for why a
 * separate component is correct here (fundamentally different content
 * model: an explicit, mixed-kind step sequence vs. a linear
 * screens-then-tasks list).
 *
 * `quiz` steps reuse the shared `QuestionCard` (`course-v2/QuestionCard.tsx`)
 * with ZERO new markup/logic — `literature_v3` quizzes are plain
 * `course_v2_questions` rows (ADR-044 §1).
 *
 * `explanation`/`definitions`/`worked_example` from `course.json` are
 * intentionally NEVER rendered here (US-31.2 КП-6, INTEGRATION.md's own
 * explicit instruction — their material is already represented in `flow`).
 *
 * NOT implemented in this slice (see handback report): persisting the exact
 * reading position (`lesson_sessions.reading_position`) across visits —
 * "Повторити" restarts the CURRENT reading step from its own beginning
 * (US-31.2 КП-2's "повтор" half), but leaving the lesson mid-reading and
 * coming back currently resumes at the start of the reading step, not the
 * exact scroll/audio offset (the "повернення до місця" half). The step/flow
 * index itself is also not yet persisted server-side for this format (same
 * gap as `MathCourseV2LessonView.tsx`/`LiteratureV2LessonView.tsx` already
 * have today — not a new limitation introduced here).
 */

function ListenButton({ refTable, refId, field, text }: { refTable: string; refId: string; field: string; text: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "unavailable">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      if (isCurrentlyPlaying(audioRef.current)) stopCurrentlyPlaying();
    },
    [],
  );

  async function play() {
    if (state === "loading") return;
    stopCurrentlyPlaying();
    setState("loading");
    try {
      const res = await narrateLiteratureV3Action({ refTable, refId, field, text });
      if (res.status !== "ok") {
        setState("unavailable");
        return;
      }
      const audio = new Audio(`data:${res.audioMime};base64,${res.audioBase64}`);
      audioRef.current = audio;
      setState("playing");
      playSingleAudio(audio, () => setState("idle"));
    } catch {
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

function ScreenStep({ step }: { step: Extract<LiteratureV3FlowStep, { kind: "screen" }> }) {
  return (
    <section className="lit-v3-step lit-v3-step-screen">
      {step.title && <h3>{step.title}</h3>}
      <p style={{ whiteSpace: "pre-wrap" }}>{step.displayText}</p>
      <div className="mt-2">
        <ListenButton refTable="literature_v3_screens" refId={step.id} field="tts" text={step.ttsText} />
      </div>
    </section>
  );
}

/** US-31.2 КП-5: passive, never evaluated, no response required. */
function BiographyStep({ step }: { step: Extract<LiteratureV3FlowStep, { kind: "biography" }> }) {
  return (
    <section className="lit-v3-step lit-v3-step-biography">
      <p className="course-eyebrow">Про автора</p>
      <h3>{step.authorName}</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{step.displayText}</p>
      <div className="mt-2">
        <ListenButton refTable="literature_v3_biographies" refId={step.id} field="tts" text={step.ttsText} />
      </div>
    </section>
  );
}

/**
 * US-31.2 КП-2/КП-3: the actual text of the work. Play/pause/"Повторити"
 * only — NO extra generated questions are ever inserted mid-reading
 * (INTEGRATION.md: "після кожного абзацу не потрібне додаткове згенероване
 * запитання" — comprehension checks happen only on explicit `quiz` steps).
 */
function ReadingStep({ step }: { step: Extract<LiteratureV3FlowStep, { kind: "reading" }> }) {
  const [playKey, setPlayKey] = useState(0);
  return (
    <section className="lit-v3-step lit-v3-step-reading">
      <p className="course-eyebrow">
        {step.workAuthor ? `${step.workAuthor} · ` : ""}
        {step.workTitle}
      </p>
      {step.title && <h3>{step.title}</h3>}
      <p style={{ whiteSpace: "pre-wrap" }}>{step.displayText}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ListenButton key={playKey} refTable="literature_v3_reading_items" refId={step.id} field="tts" text={step.ttsText} />
        <button type="button" onClick={() => setPlayKey((k) => k + 1)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold">
          🔁 Повторити
        </button>
      </div>
    </section>
  );
}

function FlowStepRenderer({ step }: { step: LiteratureV3FlowStep }) {
  switch (step.kind) {
    case "screen":
      return <ScreenStep step={step} />;
    case "biography":
      return <BiographyStep step={step} />;
    case "reading":
      return <ReadingStep step={step} />;
    case "quiz":
      // No `listenButton` here: `course_v2_questions` narration isn't in
      // either narrate action's allow-list today (true for math's own quiz
      // questions too — a pre-existing gap, not introduced by this reuse;
      // out of scope to fix here, see handback report).
      return (
        <ol className="lit-test-list">
          <QuestionCard question={step.question} />
        </ol>
      );
  }
}

function FlowNav({ lesson }: { lesson: LiteratureV3LessonViewModel }) {
  const [index, setIndex] = useState(0);
  const step = lesson.flow[index];
  if (!step) return <p className="course-note">Кроків ще немає.</p>;

  return (
    <>
      <FlowStepRenderer key={step.id} step={step} />
      <p className="course-eyebrow mt-3">
        Крок {index + 1} з {lesson.flow.length}
      </p>
      <div className="mt-1 flex gap-2">
        <button type="button" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40">
          ← Назад
        </button>
        <button
          type="button"
          disabled={index >= lesson.flow.length - 1}
          onClick={() => setIndex((i) => Math.min(lesson.flow.length - 1, i + 1))}
          className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40"
        >
          Далі →
        </button>
      </div>
    </>
  );
}

export function LiteratureV3LessonScreen({ lesson, packageLessons }: { lesson: LiteratureV3LessonViewModel; packageLessons: LiteratureV3LessonListItem[] }) {
  return (
    <article className="course-lesson">
      <LessonNavBar subjectId={lesson.subjectId} courseNav={{ basePath: "/literature-v3", currentLessonId: lesson.id, lessons: packageLessons, topicId: lesson.topicId }} />
      <header>
        <p className="course-eyebrow">{lesson.packageTitle}</p>
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

      <FlowNav lesson={lesson} />
    </article>
  );
}
