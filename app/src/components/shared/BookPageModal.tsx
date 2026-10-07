"use client";

import { useState } from "react";
import { BookReader } from "@/components/child/BookReader";

/**
 * PO request 2026-10-07: "біля задачі чи теми натискання на кнопку відкрити
 * підручник покаже конкретну сторінку підручника" — a modal (not a page
 * navigation) over the REAL textbook PDF, opened at a specific page. Reuses
 * the existing `/book/[materialId]` reader's own component (`BookReader`,
 * built 2026-10-02) — this is deliberately generic, not math-specific:
 * exactly as useful for a literature excerpt's illustration/page as for a
 * math exercise, anywhere a `materials` PDF id and a page number are known.
 */
export function OpenTextbookPageButton({
  materialId,
  title,
  pageCount,
  page,
  label,
  numberKeywordHint,
}: {
  materialId: string;
  title: string;
  pageCount: number | null;
  page: number | null;
  label?: string;
  numberKeywordHint?: string;
}) {
  const [open, setOpen] = useState(false);
  if (page == null) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold">
        {label ?? `📖 Сторінка ${page} підручника`}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4"
          onClick={() => setOpen(false)}
        >
          {/* PO complaint 2026-10-07: a fixed `max-w-2xl` was narrower than
              the reader's own rendered page, so the page overflowed
              sideways and the left part scrolled out of view. Width now
              scales with the viewport instead of a fixed cap. */}
          <div onClick={(e) => e.stopPropagation()} className="flex h-[95vh] w-[95vw] max-w-4xl flex-col overflow-hidden rounded-2xl bg-bg">
            <div className="flex items-center justify-between border-b border-line p-3">
              <p className="truncate text-sm font-bold">{title}</p>
              <button type="button" onClick={() => setOpen(false)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-sm font-bold">
                ✕ Закрити
              </button>
            </div>
            <div className="overflow-y-auto p-3">
              <BookReader materialId={materialId} title={title} initialPageCount={pageCount} initialPage={page} numberKeywordHint={numberKeywordHint} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
