"use client";

import { useEffect, useRef, useState } from "react";
import { dropCachedPdfDocument, isRenderCancelledError, loadPdfDocument, renderPdfPage, type PdfDocumentProxyLike, type PdfPageProxyLike, type PdfRenderTaskLike } from "@/components/child/pdfEngine";
import type { LiteratureV3BookPage } from "@/server/lessons/literatureV3View";

/**
 * S45 (US-31.3, ADR-044 §4 — "безшовна" virtual book, PO idea 2026-10-14):
 * stitches together several small per-lesson PDFs (`literature_v3_assets`,
 * `kind='lesson_pdf'`) into one seamless "Назад"/"Далі" reading experience —
 * the child never learns two different files are involved. Reuses the
 * SAME pdf.js engine (`pdfEngine.ts`) `BookReader.tsx` uses for the single
 * big Drive-backed PDF, fed instead from the small, local
 * `/api/book/lesson-pdf/[assetId]/file` proxy (no Drive involved at all).
 *
 * `pageIndex` is the package's full printed-page → (asset, page-inside-asset)
 * reverse index (`getLiteratureV3BookIndex`), already ordered by printed
 * page — stepping past one small PDF's last indexed page naturally lands on
 * the next asset's first page, with no special-casing here for "end of this
 * document" vs "end of the book" beyond the index's own bounds.
 */
export function VirtualBookReader({ title, pageIndex, initialPrintedPage }: { title: string; pageIndex: LiteratureV3BookPage[]; initialPrintedPage: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<PdfRenderTaskLike | null>(null);
  const prevPageRef = useRef<PdfPageProxyLike | null>(null);
  const docRef = useRef<PdfDocumentProxyLike | null>(null);
  const docAssetIdRef = useRef<string | null>(null);

  const initialIndex = Math.max(
    0,
    pageIndex.findIndex((p) => p.printedPage >= initialPrintedPage),
  );
  const [entryIndex, setEntryIndex] = useState(initialIndex === -1 ? 0 : initialIndex);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [renderError, setRenderError] = useState(false);

  const entry = pageIndex[entryIndex] ?? null;

  // Load the document for the current entry's asset whenever it changes.
  // (`entry` is only ever null if `pageIndex` is empty, which
  // `OpenVirtualBookButton` already guards against before rendering this
  // component at all — nothing to load in that defensive case.)
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const doc = await loadPdfDocument(entry.assetId, `/api/book/lesson-pdf/${entry.assetId}/file`);
        if (cancelled) return;
        docRef.current = doc;
        docAssetIdRef.current = entry.assetId;
        setStatus("ready");
      } catch {
        if (!cancelled) {
          dropCachedPdfDocument(entry.assetId);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only reload the document when the ASSET changes, not on every page step within the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.assetId]);

  // Render the current page once the right document is ready.
  useEffect(() => {
    if (status !== "ready" || !entry || docAssetIdRef.current !== entry.assetId || !docRef.current || !canvasRef.current) return;
    let cancelled = false;
    setRenderError(false);
    (async () => {
      try {
        await renderPdfPage({ doc: docRef.current!, pageNum: entry.bundlePdfPage, canvas: canvasRef.current!, maxRenderWidth: 760, refs: { renderTaskRef, prevPageRef } });
      } catch (e) {
        if (isRenderCancelledError(e)) return;
        if (!cancelled) {
          console.error(`VirtualBookReader: page ${entry.bundlePdfPage} of ${entry.assetId} render failed: ${(e as Error)?.message ?? e}`);
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, entry]);

  const canPrev = entryIndex > 0;
  const canNext = entryIndex < pageIndex.length - 1;

  return (
    <div className="px-1">
      <h2 className="mb-3 truncate text-sm font-bold">{title}</h2>
      {!entry && <p className="text-sm font-semibold text-danger">Не вдалося відкрити підручник.</p>}
      {entry && status === "loading" && <p className="text-sm text-muted">Завантаження…</p>}
      {entry && status === "error" && <p className="text-sm font-semibold text-danger">Не вдалося відкрити підручник.</p>}
      {status === "ready" && entry && (
        <>
          <div className="flex items-center justify-center overflow-x-auto rounded-2xl border border-line bg-surface p-2">
            {renderError ? <p className="p-6 text-sm text-danger">Не вдалося показати цю сторінку.</p> : <canvas ref={canvasRef} style={{ maxWidth: "100%", height: "auto" }} />}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setEntryIndex((i) => Math.max(0, i - 1))}
              disabled={!canPrev}
              className="min-h-11 rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold disabled:opacity-40"
            >
              ← Назад
            </button>
            <span className="text-xs text-muted">с. {entry.printedPage}</span>
            <button
              type="button"
              onClick={() => setEntryIndex((i) => Math.min(pageIndex.length - 1, i + 1))}
              disabled={!canNext}
              className="min-h-11 rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold disabled:opacity-40"
            >
              Далі →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
