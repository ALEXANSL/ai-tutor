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
}: {
  materialId: string;
  title: string;
  pageCount: number | null;
  page: number | null;
  label?: string;
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
          onClick={() => setOpen(false)}
        >
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-bg">
            <div className="flex items-center justify-between border-b border-line p-3">
              <p className="truncate text-sm font-bold">{title}</p>
              <button type="button" onClick={() => setOpen(false)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-sm font-bold">
                ✕ Закрити
              </button>
            </div>
            <div className="overflow-y-auto p-3">
              <BookReader materialId={materialId} title={title} initialPageCount={pageCount} initialPage={page} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
