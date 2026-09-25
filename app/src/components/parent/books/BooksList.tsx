"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { confirmOcrAction, pollIndexingAction, reindexAction, setUseInLessonsAction } from "@/app/actions/books";
import { uk } from "@/i18n/uk";
import type { BookListItem, SubjectOption } from "@/server/books/queries";

export interface KindOption {
  key: string;
  title: string;
  icon: string;
}

const control =
  "min-h-11 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary";

const IN_PROGRESS = new Set(["queued", "indexing"]);
const POLL_MS = 8000;

function StatusBadge({ book }: { book: BookListItem }) {
  const t = uk.parent.books;
  const tone =
    book.status === "ready"
      ? "bg-p-success"
      : book.status === "error" || book.status === "scan_no_text"
        ? "bg-p-danger"
        : "bg-p-warn";
  const icon = book.status === "ready" ? "✓" : book.status === "error" || book.status === "scan_no_text" ? "!" : "…";
  const step = book.progress.step ? t.progress[book.progress.step] : null;
  const isOcrStep = book.progress.step === "ocr" && book.progress.total;
  const count =
    book.progress.step === "embed" && book.progress.total ? ` ${book.progress.done ?? 0}/${book.progress.total}` : "";
  return (
    <div className="text-[12px]">
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-white ${tone}`} aria-hidden="true">
          {icon}
        </span>
        {t.status[book.status] ?? book.status}
        {book.status === "ready" && book.pageCount ? ` · ${t.pages(book.pageCount, book.format === "epub")}` : ""}
      </span>
      {IN_PROGRESS.has(book.status) && isOcrStep && (
        <div className="text-p-muted">{t.ocrProgress(book.progress.done ?? 0, book.progress.total!)}</div>
      )}
      {IN_PROGRESS.has(book.status) && !isOcrStep && step && (
        <div className="text-p-muted">
          {step}
          {count}
        </div>
      )}
      {book.status === "scan_awaiting_ocr" && <OcrConfirm book={book} />}
      {book.statusDetail && t.details[book.statusDetail] && <div className="mt-0.5 max-w-72 text-p-muted">{t.details[book.statusDetail]}</div>}
      {book.costUsd > 0 && (
        <div className="text-p-muted" title={t.costTitle}>
          {t.cost(book.costUsd.toFixed(book.costUsd < 0.1 ? 3 : 2))}
        </div>
      )}
    </div>
  );
}

/** D-54: a large scan waits here for the parent's "Розпізнати" before any AI spend. */
function OcrConfirm({ book }: { book: BookListItem }) {
  const t = uk.parent.books.ocrConfirm;
  return (
    <div className="mt-1 max-w-72 rounded-lg bg-p-warn/10 p-2">
      <div className="font-semibold text-p-text">{t.title(book.ocrPagesTotal ?? 0)}</div>
      {book.ocrEstimatedCostUsd != null && <div className="text-p-muted">{t.estimate(book.ocrEstimatedCostUsd.toFixed(2))}</div>}
      <form action={confirmOcrAction} className="mt-1">
        <input type="hidden" name="materialId" value={book.id} />
        <button type="submit" className="min-h-11 text-[12px] font-bold text-p-primary">
          {t.button}
        </button>
      </form>
    </div>
  );
}

function UseToggle({ book }: { book: BookListItem }) {
  const [pending, start] = useTransition();
  const t = uk.parent.books;
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-[13px]">
      <input
        type="checkbox"
        className="h-5 w-5 accent-[var(--p-primary)]"
        checked={book.useInLessons}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          start(() => setUseInLessonsAction(book.id, next));
        }}
        aria-label={`${t.useInLessons}: ${book.name}`}
      />
      <span>{book.useInLessons ? t.useOn : t.useOff}</span>
    </label>
  );
}

function ReindexButton({ id, disabled }: { id: string; disabled: boolean }) {
  return (
    <form action={reindexAction} className="inline-block">
      <input type="hidden" name="materialId" value={id} />
      <button type="submit" disabled={disabled} className="min-h-11 text-[12px] font-bold text-p-primary disabled:text-p-muted">
        {uk.parent.books.reindex}
      </button>
    </form>
  );
}

/**
 * "Мої книги" list (US-2.7 KP-1): type, subject, status, "use in lessons"
 * switch, date; search by name, filters by type/subject, newest first.
 * While a book is indexing, the list refreshes itself and nudges the jobs.
 */
export function BooksList({
  initial,
  subjects,
  kinds,
  timeZone,
}: {
  initial: BookListItem[];
  subjects: SubjectOption[];
  kinds: KindOption[];
  timeZone: string;
}) {
  const t = uk.parent.books;
  // Fresh server data (after revalidation) wins over older polled data.
  const [polled, setPolled] = useState<{ from: BookListItem[]; books: BookListItem[] } | null>(null);
  const books = polled && polled.from === initial ? polled.books : initial;
  const [q, setQ] = useState("");
  const [subject, setSubject] = useState("");
  const [kind, setKind] = useState("");

  const busy = books.some((b) => IN_PROGRESS.has(b.status));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(async () => {
      try {
        const fresh = await pollIndexingAction();
        setPolled({ from: initial, books: fresh });
      } catch {
        // offline for a moment — next tick
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, initial]);

  const kindBy = useMemo(() => new Map(kinds.map((k) => [k.key, k])), [kinds]);
  const subjectBy = useMemo(() => new Map(subjects.map((s) => [s.id, s.name])), [subjects]);
  const dateFmt = useMemo(() => new Intl.DateTimeFormat("uk-UA", { timeZone, day: "numeric", month: "short", year: "numeric" }), [timeZone]);

  const needle = q.trim().toLowerCase();
  const shown = books.filter(
    (b) =>
      (!needle || b.name.toLowerCase().includes(needle) || (b.title ?? "").toLowerCase().includes(needle)) &&
      (!kind || b.kind === kind) &&
      (!subject || (subject === "none" ? !b.subjectId : b.subjectId === subject)),
  );

  if (books.length === 0) return <p className="text-[14px] text-p-muted">{t.empty}</p>;

  return (
    <>
      <div className="mb-3.5 flex flex-wrap gap-2.5">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.searchByName}
          aria-label={t.searchByName}
          className={`${control} min-w-40 flex-1`}
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t.allTypes} className={control}>
          <option value="">{t.allTypes}</option>
          {kinds.map((k) => (
            <option key={k.key} value={k.key}>
              {k.title}
            </option>
          ))}
        </select>
        <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label={t.allSubjects} className={control}>
          <option value="">{t.allSubjects}</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value="none">{t.noSubject}</option>
        </select>
      </div>
      <p className="mb-2 text-xs text-p-muted" aria-live="polite">
        {t.found(shown.length, books.length)}
      </p>
      {shown.length === 0 && <p className="text-[14px] text-p-muted">{t.nothingFound}</p>}

      {/* Phone: cards; tablet/laptop: table (mockup 17). */}
      <ul className="flex flex-col gap-2.5 min-[820px]:hidden">
        {shown.map((b) => (
          <li key={b.id} className="rounded-xl border border-p-line p-3.5">
            <div className="flex items-start gap-2.5">
              <span className="text-xl" aria-hidden="true">
                {kindBy.get(b.kind)?.icon ?? "📄"}
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/parent/books/${b.id}`} className="block font-bold break-words">
                  {b.title ?? b.name}
                </Link>
                <div className="text-xs text-p-muted">
                  {kindBy.get(b.kind)?.title ?? b.kind} · {b.subjectId ? subjectBy.get(b.subjectId) : t.noSubject} · {dateFmt.format(new Date(b.addedAt))}
                </div>
              </div>
            </div>
            <div className="mt-2">
              <StatusBadge book={b} />
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <UseToggle book={b} />
              <ReindexButton id={b.id} disabled={IN_PROGRESS.has(b.status)} />
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto min-[820px]:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-p-muted uppercase">
              {[t.col.file, t.col.type, t.col.subject, t.col.status, t.col.use, t.col.added, ""].map((h, i) => (
                <th key={i} className="border-b border-p-line px-2.5 py-2 font-bold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.id} className="align-middle">
                <td className="border-b border-p-line px-2.5 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8.5 w-8.5 flex-none items-center justify-center rounded-lg bg-p-bg" aria-hidden="true">
                      {kindBy.get(b.kind)?.icon ?? "📄"}
                    </span>
                    <div className="min-w-0">
                      <Link href={`/parent/books/${b.id}`} className="font-semibold break-words hover:text-p-primary">
                        {b.title ?? b.name}
                      </Link>
                      {b.title && <div className="text-[11px] break-all text-p-muted">{b.name}</div>}
                    </div>
                  </div>
                </td>
                <td className="border-b border-p-line px-2.5 py-2.5">
                  <span className="rounded-full bg-p-primary/15 px-2 py-0.5 text-[11px] font-extrabold text-p-primary">
                    {kindBy.get(b.kind)?.title ?? b.kind}
                  </span>
                </td>
                <td className="border-b border-p-line px-2.5 py-2.5">{b.subjectId ? subjectBy.get(b.subjectId) : <span className="text-p-muted">{t.noSubject}</span>}</td>
                <td className="border-b border-p-line px-2.5 py-2.5">
                  <StatusBadge book={b} />
                </td>
                <td className="border-b border-p-line px-2.5 py-2.5">
                  <UseToggle book={b} />
                </td>
                <td className="border-b border-p-line px-2.5 py-2.5 whitespace-nowrap text-p-muted">{dateFmt.format(new Date(b.addedAt))}</td>
                <td className="border-b border-p-line px-2.5 py-2.5 text-right whitespace-nowrap">
                  <Link href={`/parent/books/${b.id}`} className="mr-3 inline-flex min-h-11 items-center text-[12px] font-bold text-p-primary">
                    {t.open}
                  </Link>
                  <ReindexButton id={b.id} disabled={IN_PROGRESS.has(b.status)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
