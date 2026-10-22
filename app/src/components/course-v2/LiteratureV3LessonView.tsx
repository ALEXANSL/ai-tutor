"use client";

import { useEffect, useRef, useState } from "react";
import { LessonNavBar } from "@/components/shared/LessonNavBar";
import { NarrationButton } from "@/components/shared/NarrationButton";
import { LessonText } from "@/components/shared/LessonText";
import { LessonVoicePanel } from "@/components/voice/LessonVoicePanel";
import { AutoAdvanceToggle, VoiceModeToggle, useVoiceModeControls } from "@/components/shared/VoiceModeControls";
import { STEP_NAV_BAR_SPACER_CLASS, StepNavBar } from "@/components/shared/StepNavBar";
import { narrateLiteratureV3Action, saveReadingPositionAction } from "@/app/actions/literature-v3";
import { OpenVirtualBookButton } from "@/components/child/OpenVirtualBookButton";
import { QuestionCard } from "@/components/course-v2/QuestionCard";
import type { LiteratureV3BookPage, LiteratureV3FlowStep, LiteratureV3LessonListItem, LiteratureV3LessonView as LiteratureV3LessonViewModel, LiteratureV3ReadingPosition } from "@/server/lessons/literatureV3View";

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
 * US-31.3 (ADR-044 §4): "📖 Подивитись у підручнику" opens `VirtualBookReader`
 * (small per-lesson PDFs stitched into one seamless book, no Drive involved)
 * — at the lesson level (header button, first printed page of this lesson)
 * and on each `reading` step whose fragment has a resolvable primary page
 * (`bookPage`). `screen`/`biography` steps don't carry a single-page anchor
 * in this package version, so they get no button of their own — see
 * handback report.
 *
 * The step/flow index itself is NOT yet persisted server-side for this
 * format (same gap as `MathCourseV2LessonView.tsx`/`LiteratureV2LessonView.tsx`
 * already have today — not a new limitation introduced here); see
 * `ReadingStep`'s own doc comment for the reading-POSITION persistence this
 * slice DOES add (US-31.2 КП-2) — a coarser, honestly-scoped restore: it
 * remembers the last READING step visited (and a scroll-derived offset
 * inside it), not the lesson's overall step index. Finishing that reading
 * step and moving on (to its own quiz, say) does not clear the saved
 * position — reopening the lesson later still jumps back into that reading
 * step rather than wherever the child actually got to afterwards. Fixing
 * that needs the same "persist the whole flow index" work the paragraph
 * above already flags as a pre-existing gap across all three course-v2
 * viewers, not something to solve only for reading steps here.
 */

function ListenButton(props: {
  refTable: string; refId: string; field: string; text: string;
  autoPlay?: boolean; onEnded?: () => void;
}) {
  const { refTable, refId, field, text } = props;
  return <NarrationButton {...props} identity={JSON.stringify([refTable, refId, field, text])}
    synthesize={() => narrateLiteratureV3Action({ refTable, refId, field, text })} />;
}

function ScreenStep({ step, voiceMode, onNarrationEnded }: { step: Extract<LiteratureV3FlowStep, { kind: "screen" }>; voiceMode: boolean; onNarrationEnded?: () => void }) {
  return (
    <section className="lit-v3-step lit-v3-step-screen">
      {step.title && <h3>{step.title}</h3>}
      <LessonText text={step.displayText} />
      {step.illustrations.map((a) =>
        a.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL
          <img key={a.assetKey} src={a.url} alt={a.alt} className="course-exercise-asset mt-2" style={{ maxWidth: "100%", height: "auto" }} />
        ) : null,
      )}
      {step.illustrations.map((a) => a.caption && <p key={a.assetKey} className="text-xs text-muted">{a.caption}</p>)}
      <div className="mt-2">
        <ListenButton key={step.id} refTable="literature_v3_screens" refId={step.id} field="tts" text={step.ttsText} autoPlay={voiceMode} onEnded={onNarrationEnded} />
      </div>
    </section>
  );
}

/** US-31.2 КП-5: passive, never evaluated, no response required. */
function BiographyStep({ step, voiceMode, onNarrationEnded }: { step: Extract<LiteratureV3FlowStep, { kind: "biography" }>; voiceMode: boolean; onNarrationEnded?: () => void }) {
  return (
    <section className="lit-v3-step lit-v3-step-biography">
      <p className="course-eyebrow">Про автора</p>
      <h3>{step.authorName}</h3>
      <LessonText text={step.displayText} />
      <div className="mt-2">
        <ListenButton key={step.id} refTable="literature_v3_biographies" refId={step.id} field="tts" text={step.ttsText} autoPlay={voiceMode} onEnded={onNarrationEnded} />
      </div>
    </section>
  );
}

/**
 * US-31.2 КП-2/КП-3: the actual text of the work. Play/pause/"Повторити"
 * only — NO extra generated questions are ever inserted mid-reading
 * (INTEGRATION.md: "після кожного абзацу не потрібне додаткове згенероване
 * запитання" — comprehension checks happen only on explicit `quiz` steps).
 *
 * US-31.3: "📖 Подивитись у підручнику" here (when `step.bookPage` resolves)
 * opens the virtual book at the printed page this fragment actually starts
 * on, not just the lesson's own first page.
 *
 * US-31.2 КП-2 ("повернення до місця"): the text lives in its own
 * scrollable panel; scroll position is mapped to a Unicode CODE POINT
 * offset of `step.ttsText` (never a JS UTF-16 string index —
 * INTEGRATION.md's explicit requirement) and saved via
 * `saveReadingPositionAction` whenever this step is left (component
 * unmount — navigating to another step, or away from the lesson entirely)
 * or the tab is hidden/closed (`visibilitychange`/`pagehide`). On the
 * step's OWN mount, if `initialOffsetCodepoints` was restored from a prior
 * visit, the panel scrolls back to roughly that position. This is a
 * best-effort scroll restore, not exact-character — no live audio seek is
 * implemented in this slice (see this component's own header).
 */
function ReadingStep({
  step,
  packageTitle,
  bookIndex,
  lessonId,
  initialOffsetCodepoints,
  voiceMode,
}: {
  step: Extract<LiteratureV3FlowStep, { kind: "reading" }>;
  packageTitle: string;
  bookIndex: LiteratureV3BookPage[];
  lessonId: string;
  initialOffsetCodepoints: number | null;
  voiceMode: boolean;
}) {
  const [playKey, setPlayKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(initialOffsetCodepoints ?? 0);
  const totalCodepoints = Math.max(1, Array.from(step.ttsText).length);

  // Restore scroll once, after layout.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || initialOffsetCodepoints == null) return;
    const ratio = Math.min(1, initialOffsetCodepoints / totalCodepoints);
    const frame = requestAnimationFrame(() => {
      el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const ratio = maxScroll > 0 ? el.scrollTop / maxScroll : 0;
    offsetRef.current = Math.round(ratio * totalCodepoints);
  }

  // Save on hide/close and on leaving this step (unmount).
  useEffect(() => {
    function save() {
      void saveReadingPositionAction({ lessonId, refId: step.id, offsetCodepoints: offsetRef.current });
    }
    function onVisibilityChange() {
      if (document.hidden) save();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", save);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [lessonId, step.id]);

  return (
    <section className="lit-v3-step lit-v3-step-reading">
      <p className="course-eyebrow">
        {step.workAuthor ? `${step.workAuthor} · ` : ""}
        {step.workTitle}
      </p>
      {step.title && <h3>{step.title}</h3>}
      <div ref={containerRef} onScroll={onScroll} className="lesson-reading-scroll" style={{ maxHeight: "60vh", overflowY: "auto" }}>
        <LessonText text={step.displayText} preserveLines />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <ListenButton key={`${step.id}-${playKey}`} refTable="literature_v3_reading_items" refId={step.id} field="tts" text={step.ttsText} autoPlay={voiceMode} />
        <button type="button" onClick={() => setPlayKey((k) => k + 1)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold">
          🔁 Повторити
        </button>
        <OpenVirtualBookButton title={packageTitle} pageIndex={bookIndex} printedPage={step.bookPage} />
      </div>
    </section>
  );
}

function FlowStepRenderer({
  step,
  packageTitle,
  bookIndex,
  lessonId,
  initialReadingOffset,
  voiceMode,
  onNarrationEnded,
}: {
  step: LiteratureV3FlowStep;
  packageTitle: string;
  bookIndex: LiteratureV3BookPage[];
  lessonId: string;
  initialReadingOffset: number | null;
  voiceMode: boolean;
  onNarrationEnded?: () => void;
}) {
  switch (step.kind) {
    case "screen":
      return <ScreenStep step={step} voiceMode={voiceMode} onNarrationEnded={onNarrationEnded} />;
    case "biography":
      return <BiographyStep step={step} voiceMode={voiceMode} onNarrationEnded={onNarrationEnded} />;
    case "reading":
      // No auto-advance here even in voice mode — the child may still be
      // reading when the audio ends; "🔁 Повторити"/scroll stay manual.
      return <ReadingStep step={step} packageTitle={packageTitle} bookIndex={bookIndex} lessonId={lessonId} initialOffsetCodepoints={initialReadingOffset} voiceMode={voiceMode} />;
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

function FlowNav({
  lesson,
  bookIndex,
  savedPosition,
  voiceMode,
  autoAdvance,
}: {
  lesson: LiteratureV3LessonViewModel;
  bookIndex: LiteratureV3BookPage[];
  savedPosition: LiteratureV3ReadingPosition | null;
  voiceMode: boolean;
  autoAdvance: boolean;
}) {
  const savedStepIndex = savedPosition ? lesson.flow.findIndex((s) => s.id === savedPosition.refId) : -1;
  const [index, setIndex] = useState(savedStepIndex >= 0 ? savedStepIndex : 0);
  const [interruptedStep, setInterruptedStep] = useState<string | null>(null);
  const step = lesson.flow[index];
  if (!step) return <p className="course-note">Кроків ще немає.</p>;
  const initialReadingOffset = step.kind === "reading" && savedPosition?.refId === step.id ? savedPosition.offsetCodepoints : null;

  const isLast = index >= lesson.flow.length - 1;
  // Only `screen`/`biography` steps auto-advance on narration end — `reading`
  // never does (see `FlowStepRenderer`'s comment), and `quiz` has no
  // narration at all.
  const onNarrationEnded = voiceMode && autoAdvance && !isLast && (step.kind === "screen" || step.kind === "biography") ? () => setIndex((i) => Math.min(lesson.flow.length - 1, i + 1)) : undefined;

  return (
    <>
      <FlowStepRenderer
        key={step.id}
        step={step}
        packageTitle={lesson.packageTitle}
        bookIndex={bookIndex}
        lessonId={lesson.id}
        initialReadingOffset={initialReadingOffset}
        voiceMode={voiceMode && interruptedStep !== step.id}
        onNarrationEnded={onNarrationEnded}
      />
      {lesson.topicId && <LessonVoicePanel target={{ kind: "chapter", lessonId: lesson.id, stepId: step.id }} onActiveChange={active => { if (active) setInterruptedStep(step.id); }} />}
      <StepNavBar
        label={`Крок ${index + 1} з ${lesson.flow.length}`}
        backDisabled={index === 0}
        onBack={() => setIndex((i) => Math.max(0, i - 1))}
        nextDisabled={index >= lesson.flow.length - 1}
        onNext={() => setIndex((i) => Math.min(lesson.flow.length - 1, i + 1))}
        middleControl={<OpenVirtualBookButton title={lesson.packageTitle} pageIndex={bookIndex} printedPage={lesson.printedPageFrom} label="📖 Відкрити підручник" />}
      />
    </>
  );
}

export function LiteratureV3LessonScreen({
  lesson,
  packageLessons,
  bookIndex,
  savedPosition,
}: {
  lesson: LiteratureV3LessonViewModel;
  packageLessons: LiteratureV3LessonListItem[];
  bookIndex: LiteratureV3BookPage[];
  savedPosition: LiteratureV3ReadingPosition | null;
}) {
  const { voiceMode, autoAdvance, changeVoiceMode, changeAutoAdvance } = useVoiceModeControls("literatureV3");

  return (
    <article className={`course-lesson ${STEP_NAV_BAR_SPACER_CLASS}`}>
      <LessonNavBar
        subjectId={lesson.subjectId}
        courseNav={{ basePath: "/literature-v3", currentLessonId: lesson.id, lessons: packageLessons, topicId: lesson.topicId }}
        extraControls={
          <>
            <VoiceModeToggle voiceMode={voiceMode} onChange={changeVoiceMode} />
            <AutoAdvanceToggle autoAdvance={autoAdvance} voiceMode={voiceMode} onChange={changeAutoAdvance} />
          </>
        }
      />
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

      <FlowNav lesson={lesson} bookIndex={bookIndex} savedPosition={savedPosition} voiceMode={voiceMode} autoAdvance={autoAdvance} />
    </article>
  );
}
