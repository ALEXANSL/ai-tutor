"use client";

import { HomeLink } from "@/components/shared/HomeLink";

import { useState } from "react";
import { createPortal } from "react-dom";
import { BookReader } from "@/components/child/BookReader";

/**
 * PO request 2026-10-07: "біля задачі чи теми натискання на кнопку відкрити
 * підручник покаже конкретну сторінку підручника" — a modal (not a page
 * navigation) over the REAL textbook PDF, opened at a specific page. Reuses
 * the existing `/book/[materialId]` reader's own component (`BookReader`,
 * built 2026-10-02) — this is deliberately generic, not math-specific:
 * exactly as useful for a literature excerpt's illustration/page as for a
 * math exercise, anywhere a `materials` PDF id and a page number are known.
 *
 * PO complaint 2026-10-16 (follow-up): "здається вона схована в фреймі
 * тексту уроку" — this button is now also used inside `StepNavBar`'s
 * `middleControl`, whose wrapper has `backdrop-blur`. A `backdrop-filter`
 * on an ancestor creates a new containing block for `position: fixed`
 * descendants, so the modal's `fixed inset-0` was being sized against that
 * small nav-bar strip instead of the viewport. Rendered via a portal into
 * `document.body` instead, so it escapes that ancestor entirely.
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
      {open &&
        createPortal(
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
                <HomeLink iconOnly />
                <p className="truncate text-sm font-bold">{title}</p>
                <button type="button" onClick={() => setOpen(false)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-sm font-bold">
                  ✕ Закрити
                </button>
              </div>
              {/* PO complaint 2026-10-16 (same bug hit via the virtual-book
                  modal, see `OpenVirtualBookButton.tsx`): without `min-h-0`, a
                  flex item grows past the parent's fixed `h-[95vh]` instead of
                  becoming scrollable — `overflow-y-auto` never engaged. */}
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <BookReader materialId={materialId} title={title} initialPageCount={pageCount} initialPage={page} numberKeywordHint={numberKeywordHint} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
