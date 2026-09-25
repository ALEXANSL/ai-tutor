import { describe, expect, it } from "vitest";
import { makeEpub, makeScanPdf, makeTextPdf } from "../../../tests/fixtures/generate";
import { decodeEntities, extractEpub, htmlToText } from "./extract-epub";
import { extractPdf } from "./extract-pdf";
import { chunkUnits, looksLikeScan, meaningfulChars, normalizeText, type ExtractedUnit } from "./text";

describe("PDF extraction (generated fixtures)", () => {
  it("extracts text page by page with page numbers and title", async () => {
    const bytes = await makeTextPdf(
      ["Chapter 1. Fractions\nA fraction has a numerator and a denominator.", "Chapter 2. Decimals\nDecimal fractions use a point."],
      "Math sample",
    );
    const res = await extractPdf(bytes);
    expect(res.format).toBe("pdf");
    expect(res.pageCount).toBe(2);
    expect(res.title).toBe("Math sample");
    expect(res.units.map((u) => u.page)).toEqual([1, 2]);
    expect(res.units[0]!.text).toContain("numerator and a denominator");
    expect(res.units[1]!.text).toContain("Decimals");
    expect(looksLikeScan(res.units)).toBe(false);
  });

  it("recognises a scan without a text layer (US-2.2 KP-3)", async () => {
    const res = await extractPdf(await makeScanPdf(5));
    expect(res.pageCount).toBe(5);
    expect(res.charCount).toBe(0);
    expect(looksLikeScan(res.units)).toBe(true);
  });

  it("rejects a file that is not a PDF", async () => {
    await expect(extractPdf(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });
});

describe("EPUB extraction (generated fixtures)", () => {
  const chapters = [
    { title: "Розділ 1. Дроби", html: "<h1>Розділ 1. Дроби</h1><p>Дріб має чисельник&nbsp;і знаменник.</p><p>Приклад: 3/4 &amp; 1/2.</p>" },
    { title: "Розділ 2. Відсотки", html: "<h2>Відсотки</h2><p>Відсоток — це сота частина числа.</p><script>alert(1)</script>" },
    { title: "Порожня", html: "<p>   </p>" },
  ];

  it("reads chapters in spine order with TOC titles as locators", async () => {
    const res = await extractEpub(makeEpub("Цікава математика", chapters));
    expect(res.format).toBe("epub");
    expect(res.title).toBe("Цікава математика");
    expect(res.toc).toEqual(["Розділ 1. Дроби", "Розділ 2. Відсотки", "Порожня"]);
    expect(res.units.map((u) => [u.page, u.locator])).toEqual([
      [1, "Розділ 1. Дроби"],
      [2, "Розділ 2. Відсотки"],
    ]);
    expect(res.units[0]!.text).toContain("Дріб має чисельник і знаменник.");
    expect(res.units[0]!.text).toContain("3/4 & 1/2");
    expect(res.units[1]!.text).not.toContain("alert");
  });

  it("falls back to the first heading without a nav document", async () => {
    const res = await extractEpub(makeEpub("Без змісту", chapters.slice(0, 2), { nav: false }));
    expect(res.units.map((u) => u.locator)).toEqual(["Розділ 1. Дроби", "Відсотки"]);
  });

  it("rejects broken archives", async () => {
    await expect(extractEpub(new Uint8Array([1, 2, 3]))).rejects.toThrow(/EPUB/);
  });

  it("decodes entities and strips markup", () => {
    expect(decodeEntities("&laquo;Так&raquo; &#1044;&#x0456;")).toBe("«Так» Ді");
    expect(htmlToText("<body><p>Один</p><p>Два<br/>три</p></body>")).toBe("Один\n\nДва\nтри");
  });
});

describe("normalisation and scan detection", () => {
  it("joins hyphenated words, drops NUL and soft hyphens, collapses spaces", () => {
    expect(normalizeText("зна-\nменник\u0000  і­чисельник \r\n\n\n\nкінець")).toBe("знаменник і" + "чисельник\n\nкінець");
  });

  it("counts letters and digits only", () => {
    expect(meaningfulChars(" ... 12 аб ,")).toBe(4);
  });

  it("indexes mixed books with a few image-only pages", () => {
    const text = "Текст сторінки підручника з достатньою кількістю літер для індексації.";
    const units = Array.from({ length: 10 }, (_, i) => ({ text: i < 3 ? "" : text }));
    expect(looksLikeScan(units)).toBe(false);
    expect(looksLikeScan([{ text: "" }, { text: "12" }])).toBe(true);
    expect(looksLikeScan([])).toBe(true);
  });
});

describe("chunking (ADR-008)", () => {
  const para = (n: number, word = "дріб") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ") + ".";

  it("keeps page numbers and never crosses a page boundary", () => {
    const units: ExtractedUnit[] = [
      { page: 7, locator: null, text: "Коротка сторінка про дроби." },
      { page: 8, locator: null, text: "Інша сторінка." },
    ];
    const chunks = chunkUnits(units);
    expect(chunks.map((c) => [c.ordinal, c.page, c.text])).toEqual([
      [0, 7, "Коротка сторінка про дроби."],
      [1, 8, "Інша сторінка."],
    ]);
  });

  it("splits long pages into ≤ maxChars chunks with overlap", () => {
    const text = [para(150), para(150, "знаменник"), para(150, "чисельник")].join("\n\n");
    const chunks = chunkUnits([{ page: 3, locator: null, text }], { maxChars: 1200, overlapChars: 100, minTailChars: 50 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.page).toBe(3);
      expect(c.text.length).toBeLessThanOrEqual(1200);
    }
    // overlap: the second chunk starts with the tail of the first
    const firstTail = chunks[0]!.text.slice(-40).trim().split(" ").at(-1)!;
    expect(chunks[1]!.text.startsWith(firstTail) || chunks[1]!.text.includes(firstTail)).toBe(true);
    // all content is preserved
    const all = chunks.map((c) => c.text).join(" ");
    expect(all).toContain("дріб149.");
    expect(all).toContain("чисельник149.");
  });

  it("hard-splits a single very long sentence", () => {
    const chunks = chunkUnits([{ page: 1, locator: "Глава", text: "а".repeat(5000) }], {
      maxChars: 1000,
      overlapChars: 0,
      minTailChars: 0,
    });
    expect(chunks.every((c) => c.text.length <= 1000 && c.locator === "Глава")).toBe(true);
    expect(chunks.map((c) => c.text).join("").length).toBe(5000);
  });

  it("merges a tiny tail into the previous chunk and skips empty pages", () => {
    const chunks = chunkUnits(
      [
        { page: 1, locator: null, text: `${para(80)}\n\nКінець.` },
        { page: 2, locator: null, text: " ... " },
      ],
      { maxChars: 900, overlapChars: 0, minTailChars: 100 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.endsWith("Кінець.")).toBe(true);
  });
});
