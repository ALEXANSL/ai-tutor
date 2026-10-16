"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { VirtualBookReader } from "@/components/child/VirtualBookReader";
import type { LiteratureV3BookPage } from "@/server/lessons/literatureV3View";

/**
 * S45 (US-31.3) — "📖 Подивитись у підручнику" for the `literature_v3`
 * chapter-package format. Same modal shell as `BookPageModal.tsx`'s
 * `OpenTextbookPageButton` (shared look/feel for "open the book" anywhere in
 * the app), wrapping `VirtualBookReader` instead of the Drive-backed
 * `BookReader` — no Drive/materialId involved here at all (ADR-044 §4).
 *
 * PO complaint 2026-10-16 (follow-up): "здається вона схована в фреймі
 * тексту уроку" — this button now lives inside `StepNavBar`'s
 * `middleControl`, whose own wrapper has `backdrop-blur`. A `backdrop-filter`
 * on an ancestor creates a new containing block for `position: fixed`
 * descendants, so the modal's `fixed inset-0` was being sized against that
 * small nav-bar strip instead of the viewport. Rendered via a portal into
 * `document.body` instead, so it escapes that ancestor entirely.
 */
export function OpenVirtualBookButton({
  title,
  pageIndex,
  printedPage,
  label,
}: {
  title: string;
  pageIndex: LiteratureV3BookPage[];
  printedPage: number | null;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (printedPage == null || pageIndex.length === 0) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold">
        {label ?? "📖 Подивитись у підручнику"}
      </button>
      {open &&
        createPortal(
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4" onClick={() => setOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} className="flex h-[95vh] w-[95vw] max-w-4xl flex-col overflow-hidden rounded-2xl bg-bg">
              <div className="flex items-center justify-between border-b border-line p-3">
                <p className="truncate text-sm font-bold">{title}</p>
                <button type="button" onClick={() => setOpen(false)} className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-sm font-bold">
                  ✕ Закрити
                </button>
              </div>
              {/* PO complaint 2026-10-16 ("в уроці відкриваю підручник і він не
                  скролиться... лише закрити"): without `min-h-0`, a flex
                  item's own content (the rendered page + Назад/Далі buttons)
                  simply grows past the parent's fixed `h-[95vh]` instead of
                  becoming scrollable — `overflow-y-auto` here never got a
                  chance to engage, and the outer `overflow-hidden` just
                  clipped the overflow silently, including the nav buttons. */}
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <VirtualBookReader title={title} pageIndex={pageIndex} initialPrintedPage={printedPage} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
