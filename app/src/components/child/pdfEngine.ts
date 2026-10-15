/**
 * S45 (US-31.3, ADR-044 §4) — pdf.js logic shared by `BookReader.tsx` (one
 * big Drive-backed PDF) and `VirtualBookReader.tsx` (several small
 * Supabase-Storage-backed per-lesson PDFs, "virtual book"). Extracted
 * VERBATIM from `BookReader.tsx` — same cache, same cancel-in-flight, same
 * per-page `cleanup()` — so both readers share the exact fixes the three PO
 * memory/rendering complaints below already paid for, instead of a new
 * component re-introducing one of them:
 *   - 2026-10-07: "сторінка уроку вилітає, потрібно перезавантажувати" —
 *     pdf.js keeps every visited page's decoded fonts/images resident until
 *     told otherwise; releasing the PREVIOUS page's resources once we've
 *     moved past it keeps memory bounded to ~1 page at a time.
 *   - 2026-10-07: "Не вдалося показати цю сторінку" right after jumping to a
 *     search hit — a still-in-flight render on the same `<canvas>` throws if
 *     a new page change fires before it settles; cancel it first.
 *   - 2026-10-02/07/13: repeated modal open/close (or, here, repeated small
 *     lesson-PDF switches) re-fetching+re-parsing the whole document is a
 *     much heavier memory-pressure source than per-page accumulation —
 *     caching the parsed document per cache key across mounts avoids that.
 *
 * `BookReader.tsx`'s own behaviour is UNCHANGED by this extraction (same
 * cache keyed the same way, same render/cleanup/cancel sequence) — this
 * module is a pure "move", not a rewrite.
 */

export interface PdfDocumentProxyLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxyLike>;
  destroy(): void;
}
export interface PdfRenderTaskLike {
  promise: Promise<void>;
  cancel(): void;
}
export interface PdfPageProxyLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): PdfRenderTaskLike;
  /** Releases this page's own decoded/cached resources (fonts, images) while
   * keeping the document open — pdf.js keeps every visited page's data
   * around otherwise. See the page-render effect for why this matters. */
  cleanup(): void;
}

/**
 * PO complaint 2026-10-02/07/13 (repeated modal open/close re-parsing the
 * whole file each time): caching the parsed document per cache key across
 * mounts means reopening the same PDF reuses it instead of repeating the
 * full fetch+parse, and the doc is never destroyed while the tab lives.
 * Shared by every caller (one `Map` for both `BookReader` materialIds and
 * `VirtualBookReader` asset ids) — cache keys never collide across the two
 * callers in practice (uuid-shaped `assetId` vs `materialId`), and even if
 * they did, same key would just mean "same already-cached document", which
 * is harmless.
 */
const pdfDocCache = new Map<string, Promise<PdfDocumentProxyLike>>();

/**
 * Loads (or reuses) a pdf.js document for `cacheKey`, fetched from `url`.
 * `rangeChunkSize` mirrors `BookReader.tsx`'s own PO-motivated choice
 * (2026-10-13: passing `url` instead of pre-fetched bytes lets pdf.js make
 * its own HTTP Range requests against a streaming-capable server route,
 * fetching only the small xref/structure chunk plus whatever page is
 * actually being rendered instead of the whole file up front).
 */
export function loadPdfDocument(cacheKey: string, url: string, rangeChunkSize = 131072): Promise<PdfDocumentProxyLike> {
  const cached = pdfDocCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return (await pdfjsLib.getDocument({ url, rangeChunkSize }).promise) as unknown as PdfDocumentProxyLike;
  })();
  promise.catch(() => pdfDocCache.delete(cacheKey));
  pdfDocCache.set(cacheKey, promise);
  return promise;
}

/** Drops a cache entry (e.g. on an unrecoverable load error) so a later retry re-fetches instead of reusing a rejected promise. */
export function dropCachedPdfDocument(cacheKey: string): void {
  pdfDocCache.delete(cacheKey);
}

export interface PdfPageRenderRefs {
  renderTaskRef: { current: PdfRenderTaskLike | null };
  prevPageRef: { current: PdfPageProxyLike | null };
}

/**
 * Renders `pageNum` of `doc` onto `canvas`, scaled to fit `maxRenderWidth`.
 * Cancels any still-in-flight render on the same canvas first, and best-
 * effort releases the PREVIOUS page's resources once we've moved past it —
 * the exact sequence `BookReader.tsx`'s own page-render effect used inline
 * before this extraction (see this module's header for the PO complaints
 * each step fixes). Callers own `renderTaskRef`/`prevPageRef` (component
 * refs, so they survive across renders) and should let
 * `RenderingCancelledException` through silently, same as `BookReader.tsx`
 * already does — a render this function itself cancelled rejects too, and
 * that is expected, not a real failure to report.
 */
export async function renderPdfPage(params: { doc: PdfDocumentProxyLike; pageNum: number; canvas: HTMLCanvasElement; maxRenderWidth: number; refs: PdfPageRenderRefs }): Promise<void> {
  const { doc, pageNum, canvas, maxRenderWidth, refs } = params;
  refs.renderTaskRef.current?.cancel();
  try {
    refs.prevPageRef.current?.cleanup();
  } catch {
    // best-effort only, see module header
  }
  const pdfPage = await doc.getPage(pageNum);
  refs.prevPageRef.current = pdfPage;
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(2, maxRenderWidth / base.width);
  const viewport = pdfPage.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const task = pdfPage.render({ canvasContext: ctx, viewport });
  refs.renderTaskRef.current = task;
  await task.promise;
  refs.renderTaskRef.current = null;
}

/** `true` for the expected, silent rejection of a render this module itself cancelled (see `renderPdfPage`) — callers should `return` on this, not surface it as an error. */
export function isRenderCancelledError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "RenderingCancelledException";
}
