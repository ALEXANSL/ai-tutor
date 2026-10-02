"use client";

import { useMemo } from "react";
import { LiteratureTest } from "@/components/literature/LiteratureLessonView";
import { LessonNavBar } from "@/components/shared/LessonNavBar";
import { MathText } from "@/components/shared/MathText";
import type { LiteratureTestQuestionView } from "@/server/lessons/literatureView";
import type { CourseLessonView, CourseSourceImageView } from "@/server/lessons/courseView";

/**
 * S34 ($0 course-package importer) — minimal child-facing viewer for one
 * imported `course_lessons` row (the Істер math textbook package and
 * similar image-anchored packages). Deliberately small, mirroring
 * `LiteratureLessonView.tsx`'s own "demonstrable today" scope:
 *
 * - `teacherNotesMd` is rendered through `MathText` (2026-10-02 fix — the
 *   raw `$...$`/`$$...$$` source used to be shown verbatim, unreadable:
 *   "Обчисли $2-\frac12:\frac14$." — real `katex` is now wired in, see
 *   `components/shared/MathText.tsx`).
 * - The test reuses `LiteratureTest` AS-IS (not a re-implementation): this
 *   package's `automatic_questions` (single_choice, exactly 4 options,
 *   `correct_option_id`) maps cleanly onto `LiteratureTest`'s `single`
 *   question type, so the exact same scoring UI AND the mandatory
 *   "Пропустити" skip button (with its "won't count" confirm warning) come
 *   for free, with no duplicated logic.
 * - Source-material/exercise IMAGES are the authoritative content here
 *   (never the `searchTextOcr` aid) — shown large, with the OCR text
 *   available only as a small secondary caption, clearly labelled
 *   unreliable, never as if it were the real condition.
 * - Exercises ("довідкові приклади з підручника") are a simple reference
 *   list with their images only — no manual-grading UI (explicitly out of
 *   scope today, per the brief).
 */

function toLiteratureTestQuestions(lesson: CourseLessonView): LiteratureTestQuestionView[] {
  return lesson.automaticQuestions.map((q) => {
    const optionIndex = q.options.findIndex((o) => o.id === q.correctOptionId);
    return {
      id: q.id,
      type: "single",
      questionUk: q.promptMd,
      options: q.options.map((o) => o.textMd),
      answer: optionIndex >= 0 ? optionIndex : undefined,
      explanationUk: q.explanationMd,
    };
  });
}

/**
 * PO correction 2026-10-02: "текст на малюнках він є ж в тестовому вигляді,
 * його можна прочитати, роби щось з дизайном, таке навіть дорослий читати
 * не буде" — the recognized text (`searchTextOcr`) is the actual readable
 * content; the photo itself is now a secondary, collapsed "original page"
 * reference rather than the primary (and largely unreadable-at-screen-size)
 * thing shown. The OCR text is still only an aid (never treated as the
 * authoritative condition — see the file header), so the real page stays
 * one tap away.
 */
function SourceImage({ img }: { img: CourseSourceImageView }) {
  return (
    <figure className="course-source-block">
      {img.searchTextOcr ? (
        <p className="course-source-text">
          <MathText text={img.searchTextOcr} />
        </p>
      ) : (
        <p className="course-note">(текст не розпізнано — дивись фото сторінки нижче)</p>
      )}
      {img.url && (
        <details className="course-source-photo">
          <summary>Показати фото сторінки{img.printedPage != null ? ` (с. ${img.printedPage})` : ""}</summary>
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL, not a static asset next/image can optimize */}
          <img src={img.url} alt={img.searchTextOcr ? img.searchTextOcr.slice(0, 120) : "Сторінка підручника"} loading="lazy" />
        </details>
      )}
    </figure>
  );
}

function ExerciseCard({ exercise }: { exercise: CourseLessonView["exercises"][number] }) {
  return (
    <li className="course-exercise-card">
      <p className="course-exercise-number">№ {exercise.originalNumber}</p>
      {exercise.measurementWarning && (
        <p className="course-warning">Для цієї вправи потрібен фізичний масштаб — вимірюй за роздрукованим рисунком, не за екраном.</p>
      )}
      {exercise.images.map((img, i) => (
        <SourceImage key={i} img={img} />
      ))}
    </li>
  );
}

const KIND_LABEL: Record<CourseLessonView["kind"], string> = {
  lesson: "Параграф",
  review: "Повторення",
  assessment: "Самостійна/перевірочна робота",
};

export function CourseLessonScreen({ lesson }: { lesson: CourseLessonView }) {
  const testQuestions = useMemo(() => toLiteratureTestQuestions(lesson), [lesson]);

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
        {lesson.status === "needs_review" && (
          <p className="course-warning">Цей урок ще потребує перевірки дорослого — частину архіву не вдалося повністю розпізнати при імпорті.</p>
        )}
      </header>

      <section>
        <h2>Коротке пояснення</h2>
        <p className="course-note">
          Це лише коротка адаптація, а не заміна підручника — повна умова, формули й приклади є на зображеннях нижче.
        </p>
        <p style={{ whiteSpace: "pre-wrap" }}>
          <MathText text={lesson.teacherNotesMd} />
        </p>
      </section>

      {lesson.sourceImages.length > 0 && (
        <section>
          <h2>Сторінки підручника</h2>
          <div className="course-source-images">
            {lesson.sourceImages.map((img, i) => (
              <SourceImage key={i} img={img} />
            ))}
          </div>
        </section>
      )}

      {lesson.exercises.length > 0 && (
        <section>
          <h2>Довідкові приклади з підручника</h2>
          <p className="course-note">
            Це оригінальні номери з підручника ({lesson.exerciseTotalCount} усього в темі) — їх перевіряє дорослий чи репетитор, тут вони лише для довідки.
          </p>
          <ol className="course-exercise-list">
            {lesson.exercises.map((e) => (
              <ExerciseCard key={e.exerciseKey} exercise={e} />
            ))}
          </ol>
        </section>
      )}

      <section>
        <h2>Тест</h2>
        <LiteratureTest questions={testQuestions} />
      </section>
    </article>
  );
}
