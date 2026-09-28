import { z } from "zod";
import { estimateCostUsd } from "../ai/policy";
import type { ModelPrice } from "../ai/types";
import { meaningfulChars, SCAN_MIN_CHARS_PER_PAGE, type ExtractedUnit } from "./text";

/**
 * OCR of scanned books (D-54, ADR-008 note): pure helpers only — no I/O, no
 * AI or Drive calls — so they are unit-tested directly. The job that uses
 * them (`ingest.ocr`, pipeline.ts) does the downloading, PDF splitting and
 * model calls.
 */

/** Pages per vision request: small enough to stay cheap to retry after a crash, big enough to amortise the request. */
export const OCR_BATCH_PAGES = 6;

/** Rough tokens per scanned page (PDF page sent as an image) — used only for the pre-flight cost estimate shown to the parent (docs/03). */
export const OCR_ASSUMED_INPUT_TOKENS_PER_PAGE = 1600;
export const OCR_ASSUMED_OUTPUT_TOKENS_PER_PAGE = 700;

/** Pages (1-based) whose extracted text layer is missing or too thin to use — the same rule as `looksLikeScan`, applied per page (US-2.2 KP-3, D-54). */
export function pagesNeedingOcr(units: Pick<ExtractedUnit, "page" | "text">[]): number[] {
  return units.filter((u) => meaningfulChars(u.text) < SCAN_MIN_CHARS_PER_PAGE).map((u) => u.page);
}

/**
 * Share of textless pages above which a book is treated as a genuine (at
 * least partial) scan worth OCR-ing — below it, the textless pages are
 * presumed to be non-text illustration/divider pages (a cover, a chapter
 * divider, a full-page AI-generated picture with only a printed page number)
 * rather than scanned content whose recognition was missed. Deliberately a
 * much looser bar than `looksLikeScan`'s 10 %: that constant answers "is
 * this book unusable without OCR" (≥ 90 % textless); this one answers "is it
 * even worth trying to recognise the textless minority of an otherwise fine
 * book" (bug 2026-09-28: a 123-page real-text book with 30 illustration
 * pages — 24.4 % textless — was blocking indexing of the other 93 pages
 * while waiting on an OCR confirmation those 30 pages never needed).
 */
export const OCR_MIN_TEXTLESS_SHARE = 0.3;

/**
 * Absolute safety net (D-54 point 4): even a proportionally small textless
 * share can mean a lot of *actual* missed content once a book is huge, so a
 * very large absolute count of textless pages still routes through OCR
 * (auto or parent-confirmed, per `needsOcrConfirmation`) regardless of the
 * book's total size.
 */
export const OCR_TEXTLESS_ABSOLUTE_SAFETY_PAGES = 200;

/**
 * Whether the textless pages of a book are worth OCR-ing at all (D-54
 * refinement). `false` means: skip the OCR pipeline entirely for this book
 * — no cost, no `scan_awaiting_ocr` block — and index the real-text pages
 * as-is; the textless pages simply produce no chunks (the same safe state
 * as a page whose only content is an uncaptioned image/diagram).
 */
export function bookNeedsOcr(textlessPageCount: number, totalPageCount: number): boolean {
  if (textlessPageCount <= 0) return false;
  if (textlessPageCount >= OCR_TEXTLESS_ABSOLUTE_SAFETY_PAGES) return true;
  if (totalPageCount <= 0) return true;
  return textlessPageCount / totalPageCount > OCR_MIN_TEXTLESS_SHARE;
}

/** Splits a page list into fixed-size batches, one vision request each. */
export function batchPages(pages: number[], size: number = OCR_BATCH_PAGES): number[][] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: number[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

export function ocrResultSchema(batchLen: number) {
  return z.object({
    pages: z
      .array(
        z.object({
          index: z.number().int().min(1).max(Math.max(1, batchLen)),
          text: z.string(),
          unreadable: z.boolean(),
        }),
      )
      .min(1)
      .max(batchLen),
  });
}
export type OcrResult = z.infer<ReturnType<typeof ocrResultSchema>>;

/** Estimated USD cost of recognising `pageCount` scanned pages (shown to the parent before a large book — D-54, US-2.2). */
export function estimateOcrCostUsd(pageCount: number, price: ModelPrice | null): number {
  if (pageCount <= 0) return 0;
  return estimateCostUsd(price, {
    inputTokens: pageCount * OCR_ASSUMED_INPUT_TOKENS_PER_PAGE,
    outputTokens: pageCount * OCR_ASSUMED_OUTPUT_TOKENS_PER_PAGE,
  });
}

/** A small book OCRs automatically; a book over the threshold waits for the parent's "Розпізнати" (D-54, `parent_settings.ocr_confirm_above_pages`). */
export function needsOcrConfirmation(pageCount: number, thresholdPages: number): boolean {
  return pageCount > thresholdPages;
}

/** Merges OCR text back into the page units for chunking: OCR text replaces a scanned page's (empty) text; an unreadable page stays empty and is dropped by the chunker. */
export function mergeOcrIntoUnits(units: ExtractedUnit[], ocrTextByPage: Map<number, string>): ExtractedUnit[] {
  return units.map((u) => (ocrTextByPage.has(u.page) ? { ...u, text: ocrTextByPage.get(u.page)! } : u));
}
