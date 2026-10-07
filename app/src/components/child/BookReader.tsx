"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { uk } from "@/i18n/uk";

/**
 * PDF book reader (Alex, 2026-10-02): "читалка книги в pdf форматі... з
 * пошуком по сторінках, за номером завдання/параграфу/задачі, і текстовий
 * пошук" — no AI call anywhere here, $0 marginal cost.
 *
 * Renders real PDF pages (illustrations, original layout — the whole point
 * over the plain-text `MaterialReadScreen`) client-side with `pdfjs-dist`,
 * fed from our own `/api/book/[materialId]/file` proxy (the Drive token
 * never reaches the browser, ADR-024). Search is a separate, $0 server call
 * (`/api/book/[materialId]/search`) over the already-indexed `chunks` text
 * (ADR-008) — this component never calls `page.getTextContent()` itself,
 * so a search does not need every page downloaded/parsed first.
 *
 * pdf.js types are loaded only at runtime (dynamic import, client-only: the
 * library touches `document`/`Worker` and must never run during SSR).
 */

interface PdfDocumentProxyLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxyLike>;
  destroy(): void;
}
interface PdfRenderTaskLike {
  promise: Promise<void>;
  cancel(): void;
}
interface PdfPageProxyLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): PdfRenderTaskLike;
}

interface SearchHit {
  page: number;
  locator: string | null;
  snippet: string;
}

const MAX_RENDER_WIDTH = 760;

export function BookReader({
  materialId,
  title,
  initialPageCount,
  initialPage,
  numberKeywordHint,
}: {
  materialId: string;
  title: string;
  initialPageCount: number | null;
  /** PO request 2026-10-07: "кнопка відкрити підручник покаже конкретну
   * сторінку" — jump straight to a page (an exercise's or a lesson's own
   * printed page) instead of always opening at page 1. */
  initialPage?: number;
  /** PO complaint 2026-10-07: a bare number typed in search used to always
   * fall back to full-text search. When the caller knows what a bare number
   * means here (e.g. "вправа" for a math course), pass that word and a bare
   * numeric query is treated as that keyword + number — see `runSearch`. */
  numberKeywordHint?: string;
}) {
  const t = uk.child.book;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<PdfRenderTaskLike | null>(null);
  const docRef = useRef<PdfDocumentProxyLike | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [page, setPage] = useState(initialPage && initialPage > 0 ? initialPage : 1);
  const [pageCount, setPageCount] = useState(initialPageCount ?? 0);
  const [pageInput, setPageInput] = useState(String(initialPage && initialPage > 0 ? initialPage : 1));
  const [pageError, setPageError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState(false);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [matchedAs, setMatchedAs] = useState<{ label: string; number: string } | null>(null);
  const [activeSnippet, setActiveSnippet] = useState<string | null>(null);

  // Load the document once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pdfjsLib, res] = await Promise.all([import("pdfjs-dist"), fetch(`/api/book/${materialId}/file`)]);
        if (!res.ok) throw new Error(`file ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // Served as a plain static file, copied from the installed
        // `pdfjs-dist` package by `scripts/copy-pdf-worker.mjs`
        // (`predev`/`prebuild`) — see that script for why not the usual
        // `new URL(..., import.meta.url)` bundler trick.
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const doc = (await pdfjsLib.getDocument({ data: bytes }).promise) as unknown as PdfDocumentProxyLike;
        if (cancelled) {
          doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setPage((p) => Math.min(p, doc.numPages));
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      docRef.current?.destroy();
      docRef.current = null;
    };
  }, [materialId]);

  // Render the current page whenever it changes (and once the doc is ready).
  useEffect(() => {
    if (status !== "ready" || !docRef.current || !canvasRef.current) return;
    let cancelled = false;
    setRenderError(false);
    (async () => {
      try {
        // PO complaint 2026-10-07 ("Не вдалося показати цю сторінку", right
        // after jumping straight to a search hit): pdf.js throws "Cannot use
        // the same canvas during multiple render() operations" if a
        // previous page's render() is still in flight on this same
        // `<canvas>` when a new page change fires this effect again — a
        // fast jump (search result, Далі spam) raced the still-rendering
        // old page. Cancel it first instead of letting two renders fight
        // over one canvas.
        renderTaskRef.current?.cancel();
        const doc = docRef.current!;
        const pdfPage = await doc.getPage(page);
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(2, MAX_RENDER_WIDTH / base.width);
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx || cancelled) return;
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;
      } catch (e) {
        // A render we cancelled ourselves (above) rejects too — that is
        // expected and silent, not a real failure to report.
        if ((e as { name?: string } | null)?.name === "RenderingCancelledException") return;
        if (!cancelled) {
          console.error(`BookReader: page ${page} render failed: ${(e as Error)?.message ?? e}`);
          setRenderError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, page]);

  const goToPage = useCallback(
    (n: number) => {
      const bounded = Math.max(1, Math.min(pageCount || n, n));
      setPage(bounded);
      setPageInput(String(bounded));
      setPageError(null);
    },
    [pageCount],
  );

  function submitPageInput() {
    const n = Number(pageInput);
    if (!Number.isInteger(n) || n < 1 || (pageCount > 0 && n > pageCount)) {
      setPageError(t.invalidPage(pageCount || 9999));
      return;
    }
    goToPage(n);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchError(false);
    setActiveSnippet(null);
    try {
      // PO complaint 2026-10-07: "пошук шукає по всім матеріалам а не по
      // номеру ... задачі" — a BARE number ("107") is deliberately NOT
      // treated as an item-number query server-side (`parseNumberQuery`'s
      // own comment: ambiguous between "page" and "item" for a generic
      // book), so it fell through to plain full-text search and matched the
      // digits anywhere in the book. When this reader is opened from a
      // context that already knows what kind of item its numbers are
      // (e.g. math exercises — "вправа"), prepend that keyword to a bare
      // numeric query before it ever reaches the server, so the EXISTING
      // keyword-matching regex picks it up exactly like typing "вправа 107"
      // by hand would.
      const effectiveQuery = numberKeywordHint && /^\d{1,4}[a-zа-яіїєґ]?$/iu.test(q) ? `${numberKeywordHint} ${q}` : q;
      const res = await fetch(`/api/book/${materialId}/search?q=${encodeURIComponent(effectiveQuery)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { hits: SearchHit[]; matchedAs: { label: string; number: string } | null };
      setHits(data.hits);
      setMatchedAs(data.matchedAs);
    } catch {
      setSearchError(true);
      setHits(null);
    } finally {
      setSearching(false);
    }
  }

  function openHit(hit: SearchHit) {
    setActiveSnippet(hit.snippet);
    goToPage(hit.page);
  }

  return (
    <div className="pb-10">
      <div className="px-6 pt-4">
        <Link href="#" onClick={(e) => { e.preventDefault(); history.back(); }} className="mb-3 inline-block text-sm font-bold text-muted underline">
          {t.back}
        </Link>
        <h1 className="mb-4 text-2xl font-extrabold">{title}</h1>

        <div className="mb-4 rounded-2xl border border-line bg-surface p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder={t.searchPlaceholder}
              className="min-h-11 flex-1 rounded-xl border-2 border-line bg-bg px-3 text-sm outline-none focus:border-focus"
            />
            <button
              type="button"
              onClick={runSearch}
              disabled={searching || !query.trim()}
              className="min-h-11 rounded-xl bg-primary px-3.5 text-sm font-bold text-white disabled:opacity-60"
            >
              {searching ? t.searching : t.searchButton}
            </button>
          </div>
          {matchedAs && <p className="mt-2 text-xs text-muted">{t.matchedAs(matchedAs.label, matchedAs.number)}</p>}
          {searchError && <p className="mt-2 text-xs font-semibold text-danger">{t.searchError}</p>}
          {hits !== null && !searchError && (
            <div className="mt-2">
              {hits.length === 0 ? (
                <p className="text-xs text-muted">{t.noResults}</p>
              ) : (
                <>
                  <p className="mb-1 text-xs text-muted">{t.resultsCount(hits.length)}</p>
                  <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                    {hits.map((h) => (
                      <li key={h.page}>
                        <button
                          type="button"
                          onClick={() => openHit(h)}
                          className="w-full rounded-lg px-2 py-1.5 text-left text-xs hover:bg-bg"
                        >
                          <span className="font-bold">{t.resultPage(h.page, h.locator)}</span>
                          <span className="ml-1 text-muted">— {h.snippet}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {activeSnippet && (
          <p className="mb-3 rounded-xl bg-primary/10 px-3 py-2 text-xs italic text-muted">{activeSnippet}</p>
        )}

        {status === "loading" && <p className="text-sm text-muted">{t.loading}</p>}
        {status === "error" && <p className="text-sm font-semibold text-danger">{t.loadError}</p>}

        {status === "ready" && (
          <>
            <div className="flex items-center justify-center overflow-x-auto rounded-2xl border border-line bg-surface p-2">
              {renderError ? (
                <p className="p-6 text-sm text-danger">{t.renderError}</p>
              ) : (
                // PO complaint 2026-10-07 (opened inside the narrower
                // "Відкрити підручник" modal): the canvas's pixel buffer
                // stays at full render quality (MAX_RENDER_WIDTH), but its
                // CSS size now shrinks to fit the container instead of
                // overflowing it sideways — a fixed-width canvas used to
                // push the left part of the page out of view, forcing a
                // horizontal scroll just to see the whole page.
                <canvas ref={canvasRef} style={{ maxWidth: "100%", height: "auto" }} />
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1}
                className="min-h-11 rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold disabled:opacity-40"
              >
                {t.prev}
              </button>
              <span className="text-xs text-muted">{t.pageOf(page, pageCount || page)}</span>
              <button
                type="button"
                onClick={() => goToPage(page + 1)}
                disabled={pageCount > 0 && page >= pageCount}
                className="min-h-11 rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold disabled:opacity-40"
              >
                {t.next}
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs font-bold text-muted" htmlFor="book-page-input">
                {t.goToPage}
              </label>
              <input
                id="book-page-input"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitPageInput()}
                inputMode="numeric"
                className="min-h-10 w-20 rounded-xl border-2 border-line bg-bg px-2 text-sm outline-none focus:border-focus"
              />
              <button
                type="button"
                onClick={submitPageInput}
                className="min-h-10 rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold"
              >
                {t.goButton}
              </button>
            </div>
            {pageError && <p className="mt-1 text-xs font-semibold text-danger">{pageError}</p>}
          </>
        )}
      </div>
    </div>
  );
}
