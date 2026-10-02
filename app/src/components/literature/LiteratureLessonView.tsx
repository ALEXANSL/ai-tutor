"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LessonNavBar } from "@/components/shared/LessonNavBar";
import { MathText } from "@/components/shared/MathText";
import type { LiteratureLessonView, LiteratureTestQuestionView } from "@/server/lessons/literatureView";

/**
 * S33 (PO decision 2026-09-30, corrected same day) — MINIMAL read/test UI
 * for the new literature-extraction path. Deliberately does not reuse the
 * `library_steps`/`LessonRunner` step machine: this content shape (long
 * markdown-ish explanation, an excerpt block, textbook questions grouped by
 * label, a self-contained JSON test with 6 question types) does not map
 * onto that engine's step types. A future slice can fold this into the
 * shared runner if the PO wants the same visual polish/animation here —
 * out of scope for "demonstrable today".
 *
 * The test is scored client-side only (no `step_attempts` row, no session
 * tracking) — a known, called-out simplification (see the handback report).
 */

/**
 * PO correction 2026-10-02: reading the book must be a fully SEPARATE
 * action, not something embedded inside the lesson screen ("кнопка читати
 * книгу з гугл диска до самого уроку, це окремий виклик і не має
 * відношення до уроку"). The real PDF reader now exists at `/book/[materialId]`
 * (page-jump + search, built 2026-10-02) — this is just a plain navigation
 * link out of the lesson to that separate page, replacing the old inline
 * "reveal the full text here" panel that used to live inside this screen.
 */
function ReadBookLink({ materialId }: { materialId: string }) {
  return (
    <Link href={`/book/${materialId}`} className="lit-btn lit-btn-reader">
      📖 Читати книгу
    </Link>
  );
}

function PageRef({ from, to }: { from: number | null; to: number | null }) {
  if (from == null) return null;
  return <span className="lit-page-ref">{to != null && to !== from ? `с. ${from}–${to}` : `с. ${from}`}</span>;
}

function TestQuestion({
  q,
  onAnswered,
}: {
  q: LiteratureTestQuestionView;
  onAnswered: (correct: boolean | null) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openText, setOpenText] = useState("");
  const [revealed, setRevealed] = useState(false);

  const toggle = (i: number) => {
    if (revealed) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (q.type === "single" || q.type === "truefalse") {
        next.clear();
        next.add(i);
      } else if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const check = () => {
    setRevealed(true);
    if (q.type === "open" || q.type === "match" || q.type === "order") {
      onAnswered(null); // no automatic verdict for these types in this minimal UI
      return;
    }
    const expected = new Set(Array.isArray(q.answer) ? (q.answer as number[]) : q.answer != null ? [q.answer as number] : []);
    const correct = selected.size === expected.size && [...selected].every((i) => expected.has(i));
    onAnswered(correct);
  };

  /**
   * Mandatory skip button (PO correction 2026-10-02: "обов'язково кнопка
   * пропустити завдання в уроці, з нагадуванням, що урок не буде
   * зараховано") — always available, no longer gated by
   * `parent_settings.allow_skip_tests`. Warns before skipping that the
   * lesson won't count as completed; only skips on confirmation. Reveals
   * the explanation without scoring, same no-verdict path as `open`/`match`/`order`.
   */
  const skip = () => {
    if (!window.confirm("Якщо пропустиш — цей урок не буде зараховано як пройдений. Пропустити?")) return;
    setRevealed(true);
    onAnswered(null);
  };

  return (
    <li className="lit-test-q">
      <p className="lit-test-q-text">
        <MathText text={q.questionUk} />
      </p>
      {(q.type === "single" || q.type === "multiple" || q.type === "truefalse") && q.options && (
        <ul className="lit-test-options">
          {q.options.map((opt, i) => (
            <li key={i}>
              <label className={selected.has(i) ? "selected" : ""}>
                <input type={q.type === "multiple" ? "checkbox" : "radio"} checked={selected.has(i)} onChange={() => toggle(i)} disabled={revealed} />
                <MathText text={opt} />
              </label>
            </li>
          ))}
        </ul>
      )}
      {q.type === "match" && q.pairs && (
        <ul className="lit-test-pairs">
          {q.pairs.map((p, i) => (
            <li key={i}>
              <MathText text={p.leftUk} /> → <MathText text={p.rightUk} />
            </li>
          ))}
        </ul>
      )}
      {q.type === "order" && q.options && (
        <ol className="lit-test-options">
          {q.options.map((opt, i) => (
            <li key={i}>
              <MathText text={opt} />
            </li>
          ))}
        </ol>
      )}
      {q.type === "open" && (
        <textarea className="lit-test-open" value={openText} onChange={(e) => setOpenText(e.target.value)} disabled={revealed} placeholder="Твоя відповідь..." />
      )}
      {!revealed ? (
        <div className="lit-test-actions">
          <button type="button" className="lit-btn" onClick={check}>
            Перевірити
          </button>
          <button type="button" className="lit-btn lit-btn-secondary" onClick={skip}>
            Пропустити
          </button>
        </div>
      ) : (
        <p className="lit-test-explain">
          <MathText text={q.explanationUk} />
        </p>
      )}
    </li>
  );
}

export function LiteratureTest({ questions }: { questions: LiteratureTestQuestionView[] }) {
  const [results, setResults] = useState<Record<string, boolean | null>>({});
  const scored = useMemo(() => Object.values(results).filter((v) => v != null), [results]);
  const correctCount = useMemo(() => scored.filter(Boolean).length, [scored]);

  if (questions.length === 0) return <p>Тест ще не готовий.</p>;

  return (
    <div>
      <ol className="lit-test-list">
        {questions.map((q) => (
          <TestQuestion
            key={q.id}
            q={q}
            onAnswered={(correct) => setResults((prev) => ({ ...prev, [q.id]: correct }))}
          />
        ))}
      </ol>
      {scored.length > 0 && (
        <p className="lit-test-score">
          Правильно: {correctCount} з {scored.length} (перевірених автоматично)
        </p>
      )}
    </div>
  );
}

export function LiteratureLessonScreen({ lesson }: { lesson: LiteratureLessonView }) {
  return (
    <article className="lit-lesson">
      <LessonNavBar subjectId={lesson.subjectId} />
      <header>
        <p className="lit-eyebrow">
          Тема {lesson.topicNo}
          {lesson.sectionTitle ? ` · ${lesson.sectionTitle}` : ""}
        </p>
        <h1>{lesson.title}</h1>
        <p className="lit-pages">
          Підручник: <PageRef from={lesson.textbookPageFrom} to={lesson.textbookPageTo} />
          {lesson.pdfPageFrom != null && <span className="lit-page-ref"> (PDF {lesson.pdfPageFrom}{lesson.pdfPageTo && lesson.pdfPageTo !== lesson.pdfPageFrom ? `–${lesson.pdfPageTo}` : ""})</span>}
        </p>
        {lesson.status === "needs_review" && <p className="lit-warning">Цей урок ще потребує перевірки дорослого — деякі частини могли обірватися при генерації.</p>}
      </header>

      <section>
        <h2>Мета</h2>
        <p>{lesson.goalUk}</p>
      </section>

      {lesson.keyConcepts.length > 0 && (
        <section>
          <h2>Ключові поняття</h2>
          <ul>
            {lesson.keyConcepts.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Матеріал для пояснення</h2>
        <p style={{ whiteSpace: "pre-wrap" }}>{lesson.explanationMd}</p>
      </section>

      {lesson.work && (
        <section>
          <h2>Твір: {lesson.work.titleUk}</h2>
          <p className="lit-note">
            Тут лише короткий переказ і уривки (адаптація) — повний, справжній текст твору читай у підручнику,{" "}
            <PageRef from={lesson.textbookPageFrom} to={lesson.textbookPageTo} />
            {lesson.pdfPageFrom != null ? ` (PDF с. ${lesson.pdfPageFrom}${lesson.pdfPageTo && lesson.pdfPageTo !== lesson.pdfPageFrom ? `–${lesson.pdfPageTo}` : ""})` : ""}.
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{lesson.work.summaryUk}</p>
          <blockquote style={{ whiteSpace: "pre-wrap" }}>{lesson.work.excerptsUk}</blockquote>
          <ReadBookLink materialId={lesson.materialId} />
          {lesson.work.charactersUk && (
            <p>
              <strong>Персонажі:</strong> {lesson.work.charactersUk}
            </p>
          )}
          {lesson.work.ideaUk && (
            <p>
              <strong>Ідея:</strong> {lesson.work.ideaUk}
            </p>
          )}
          {lesson.work.authorBioUk && (
            <div>
              <h3>Про автора</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{lesson.work.authorBioUk}</p>
            </div>
          )}
          {lesson.work.otherWorksUk && (
            <div>
              <h3>Інші твори автора</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{lesson.work.otherWorksUk}</p>
            </div>
          )}
        </section>
      )}

      {lesson.sublessons.map((sl) => (
        <section key={sl.no}>
          <h2>
            Урок {sl.no}. {sl.titleUk}
          </h2>
          {sl.questionGroups.map((g, i) => (
            <div key={i}>
              <h3>
                {g.labelUk} <PageRef from={g.page} to={null} />
              </h3>
              <ol>
                {g.items.map((it) => (
                  <li key={it.number} value={Number(it.number) || undefined}>
                    {it.textUk}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      ))}

      {lesson.teacherNoteUk && (
        <section>
          <h2>Для вчителя / ШІ-репетитора</h2>
          <p>{lesson.teacherNoteUk}</p>
        </section>
      )}

      <section>
        <h2>Тест</h2>
        <LiteratureTest questions={lesson.test} />
      </section>
    </article>
  );
}
