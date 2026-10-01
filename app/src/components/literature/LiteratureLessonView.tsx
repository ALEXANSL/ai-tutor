"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { getLiteratureWorkFullTextAction } from "@/app/actions/literature";
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

/** On-demand full-text reveal (PO correction 2026-09-30, 3rd/final): fetches the work's complete text from the family's own Drive only when the child asks, never eagerly. */
function WorkFullTextReveal({ lessonId, available }: { lessonId: string; available: boolean }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "error" | "done"; text?: string; reason?: string }>({ status: "idle" });

  if (!available) {
    return <p className="lit-note">(повний текст твору ще не готовий — з&rsquo;явиться, коли книга буде підключена через Google Drive)</p>;
  }

  const load = async () => {
    setState({ status: "loading" });
    const result = await getLiteratureWorkFullTextAction(lessonId);
    if (result.ok) setState({ status: "done", text: result.text });
    else setState({ status: "error", reason: result.reason });
  };

  if (state.status === "done") {
    return <div className="lit-full-text" style={{ whiteSpace: "pre-wrap" }}>{state.text}</div>;
  }

  return (
    <div>
      <button type="button" className="lit-btn" onClick={load} disabled={state.status === "loading"}>
        {state.status === "loading" ? "Завантажуємо..." : "Читати повний текст твору"}
      </button>
      {state.status === "error" && <p className="lit-warning">{state.reason}</p>}
    </div>
  );
}

function PageRef({ from, to }: { from: number | null; to: number | null }) {
  if (from == null) return null;
  return <span className="lit-page-ref">{to != null && to !== from ? `с. ${from}–${to}` : `с. ${from}`}</span>;
}

function TestQuestion({
  q,
  onAnswered,
  allowSkip,
}: {
  q: LiteratureTestQuestionView;
  onAnswered: (correct: boolean | null) => void;
  allowSkip: boolean;
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

  /** Parent-settings-gated skip (PO feedback 2026-10-01): reveals the explanation without scoring, same no-verdict path as `open`/`match`/`order`. */
  const skip = () => {
    setRevealed(true);
    onAnswered(null);
  };

  return (
    <li className="lit-test-q">
      <p className="lit-test-q-text">{q.questionUk}</p>
      {(q.type === "single" || q.type === "multiple" || q.type === "truefalse") && q.options && (
        <ul className="lit-test-options">
          {q.options.map((opt, i) => (
            <li key={i}>
              <label className={selected.has(i) ? "selected" : ""}>
                <input type={q.type === "multiple" ? "checkbox" : "radio"} checked={selected.has(i)} onChange={() => toggle(i)} disabled={revealed} />
                {opt}
              </label>
            </li>
          ))}
        </ul>
      )}
      {q.type === "match" && q.pairs && (
        <ul className="lit-test-pairs">
          {q.pairs.map((p, i) => (
            <li key={i}>
              {p.leftUk} → {p.rightUk}
            </li>
          ))}
        </ul>
      )}
      {q.type === "order" && q.options && <ol className="lit-test-options">{q.options.map((opt, i) => <li key={i}>{opt}</li>)}</ol>}
      {q.type === "open" && (
        <textarea className="lit-test-open" value={openText} onChange={(e) => setOpenText(e.target.value)} disabled={revealed} placeholder="Твоя відповідь..." />
      )}
      {!revealed ? (
        <div className="lit-test-actions">
          <button type="button" className="lit-btn" onClick={check}>
            Перевірити
          </button>
          {allowSkip && (
            <button type="button" className="lit-btn lit-btn-secondary" onClick={skip}>
              Пропустити
            </button>
          )}
        </div>
      ) : (
        <p className="lit-test-explain">{q.explanationUk}</p>
      )}
    </li>
  );
}

export function LiteratureTest({ questions, allowSkip = false }: { questions: LiteratureTestQuestionView[]; allowSkip?: boolean }) {
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
            allowSkip={allowSkip}
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

export function LiteratureLessonScreen({ lesson, allowSkipTests = false }: { lesson: LiteratureLessonView; allowSkipTests?: boolean }) {
  return (
    <article className="lit-lesson">
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
        {/* PO feedback 2026-10-01: "немає читалки оригіналу" — a visible link to the full-book reader page, which existed but had no entry point from here. */}
        <p className="lit-pages">
          <Link href={`/literature/book/${lesson.materialId}`} className="lit-btn lit-btn-link">
            📖 Читати книгу
          </Link>
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
          <WorkFullTextReveal lessonId={lesson.id} available={lesson.workFullTextDriveFileId != null} />
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
        <LiteratureTest questions={lesson.test} allowSkip={allowSkipTests} />
      </section>
    </article>
  );
}
