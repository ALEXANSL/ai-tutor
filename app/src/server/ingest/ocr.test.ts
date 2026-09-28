import { describe, expect, it } from "vitest";
import {
  batchPages,
  bookNeedsOcr,
  estimateOcrCostUsd,
  mergeOcrIntoUnits,
  needsOcrConfirmation,
  ocrResultSchema,
  OCR_BATCH_PAGES,
  OCR_MIN_TEXTLESS_SHARE,
  OCR_TEXTLESS_ABSOLUTE_SAFETY_PAGES,
  pagesNeedingOcr,
} from "./ocr";

/**
 * Pure OCR helpers (D-54, ADR-008 note): scan-page detection, batching, the
 * pre-flight cost estimate, and merging OCR text back into page units. No
 * I/O — the job that calls these (pipeline.ts) is exercised with generated
 * "scanned" PDF fixtures in pipeline.test.ts.
 */
describe("pagesNeedingOcr", () => {
  it("flags pages below the scan threshold and keeps pages with real text (US-2.2 KP-3)", () => {
    const units = [
      { page: 1, text: "Повноцінний текст із досить великою кількістю символів на сторінці." },
      { page: 2, text: "" },
      { page: 3, text: "..." },
    ];
    expect(pagesNeedingOcr(units)).toEqual([2, 3]);
  });

  it("returns an empty list for a fully text book", () => {
    const units = [{ page: 1, text: "Багато тексту про дроби і знаменники, більше сорока символів." }];
    expect(pagesNeedingOcr(units)).toEqual([]);
  });
});

describe("batchPages", () => {
  it("splits a sorted, de-duplicated page list into fixed-size batches", () => {
    expect(batchPages([3, 1, 2, 2, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
  });

  it("defaults to OCR_BATCH_PAGES", () => {
    const pages = Array.from({ length: OCR_BATCH_PAGES + 1 }, (_, i) => i + 1);
    expect(batchPages(pages)).toHaveLength(2);
  });

  it("handles an empty page list", () => {
    expect(batchPages([])).toEqual([]);
  });
});

describe("ocrResultSchema", () => {
  it("accepts a well-formed answer and rejects an index out of range", () => {
    const schema = ocrResultSchema(2);
    expect(schema.safeParse({ pages: [{ index: 1, text: "a", unreadable: false }] }).success).toBe(true);
    expect(schema.safeParse({ pages: [{ index: 3, text: "a", unreadable: false }] }).success).toBe(false);
  });
});

describe("estimateOcrCostUsd (docs/03 estimate)", () => {
  const price = { input_usd_per_mtok: 2, output_usd_per_mtok: 10, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null };

  it("scales roughly linearly with page count (Sonnet 5 pricing)", () => {
    expect(estimateOcrCostUsd(0, price)).toBe(0);
    const onePage = estimateOcrCostUsd(1, price);
    expect(onePage).toBeCloseTo((1600 * 2 + 700 * 10) / 1_000_000, 6);
    expect(estimateOcrCostUsd(200, price)).toBeCloseTo(onePage * 200, 4);
  });

  it("is 0 without a known price (unpriced route — still lets the estimate render)", () => {
    expect(estimateOcrCostUsd(10, null)).toBe(0);
  });
});

describe("needsOcrConfirmation (D-54)", () => {
  it("small books OCR automatically; a book over the threshold needs the parent's 'Розпізнати'", () => {
    expect(needsOcrConfirmation(20, 20)).toBe(false);
    expect(needsOcrConfirmation(21, 20)).toBe(true);
  });
});

describe("mergeOcrIntoUnits", () => {
  it("replaces only the scanned pages' text and leaves text-layer pages untouched (mixed PDF)", () => {
    const units = [
      { page: 1, locator: null, text: "Текстова сторінка з підручника, досить довга." },
      { page: 2, locator: null, text: "" },
    ];
    const merged = mergeOcrIntoUnits(units, new Map([[2, "Розпізнаний текст сторінки 2."]]));
    expect(merged[0]!.text).toBe(units[0]!.text);
    expect(merged[1]!.text).toBe("Розпізнаний текст сторінки 2.");
  });

  it("leaves an unrecognised (unreadable) page empty, so the chunker drops it", () => {
    const units = [{ page: 5, locator: null, text: "" }];
    expect(mergeOcrIntoUnits(units, new Map())[0]!.text).toBe("");
  });
});

describe("bookNeedsOcr (D-54 refinement, bug 2026-09-28: real-book PDF with illustration pages blocked on OCR)", () => {
  it("skips OCR for a mostly-real-text book with a minority of textless (illustration) pages — the confirmed real case: 30/123 = 24.4% textless", () => {
    expect(bookNeedsOcr(30, 123)).toBe(false);
  });

  it("has no textless pages: nothing to OCR", () => {
    expect(bookNeedsOcr(0, 123)).toBe(false);
  });

  it("still requires OCR for a genuinely scan-heavy book (matches looksLikeScan's own territory: ~95% textless)", () => {
    expect(bookNeedsOcr(117, 123)).toBe(true);
  });

  it("requires OCR once the textless share crosses OCR_MIN_TEXTLESS_SHARE", () => {
    const total = 100;
    const justUnder = Math.floor(total * OCR_MIN_TEXTLESS_SHARE);
    const justOver = justUnder + 1;
    expect(bookNeedsOcr(justUnder, total)).toBe(false);
    expect(bookNeedsOcr(justOver, total)).toBe(true);
  });

  it("absolute safety net: a huge number of textless pages still requires OCR even if the share is proportionally small", () => {
    const total = 10_000;
    expect(OCR_TEXTLESS_ABSOLUTE_SAFETY_PAGES / total).toBeLessThan(OCR_MIN_TEXTLESS_SHARE);
    expect(bookNeedsOcr(OCR_TEXTLESS_ABSOLUTE_SAFETY_PAGES, total)).toBe(true);
  });

  it("a book with zero known pages but some textless count is treated as needing OCR (degenerate input, safe default)", () => {
    expect(bookNeedsOcr(5, 0)).toBe(true);
  });
});
