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
