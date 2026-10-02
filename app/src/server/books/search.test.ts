import { describe, expect, it } from "vitest";
import { parseNumberQuery, searchMaterialText, type SearchableChunk } from "./search";

describe("parseNumberQuery", () => {
  it("recognises «завдання N»", () => {
    expect(parseNumberQuery("завдання 5")).toEqual({ label: "завдання", number: "5" });
  });

  it("recognises «задача N» with a letter suffix, matching the textbook's own numbering shape", () => {
    expect(parseNumberQuery("задача 12а")).toEqual({ label: "задача", number: "12а" });
  });

  it("recognises §N with or without a space", () => {
    expect(parseNumberQuery("§3")).toEqual({ label: "§", number: "3" });
    expect(parseNumberQuery("§ 3")).toEqual({ label: "§", number: "3" });
  });

  it("recognises «параграф N» as the same §-label", () => {
    expect(parseNumberQuery("параграф 3")).toEqual({ label: "§", number: "3" });
  });

  it("recognises «Тема N»", () => {
    expect(parseNumberQuery("Тема 7")).toEqual({ label: "Тема", number: "7" });
  });

  it("recognises «вправа N» and «запитання N»", () => {
    expect(parseNumberQuery("вправа 2")).toEqual({ label: "вправа", number: "2" });
    expect(parseNumberQuery("запитання 9")).toEqual({ label: "запитання", number: "9" });
  });

  it("is case-insensitive", () => {
    expect(parseNumberQuery("ЗАВДАННЯ 5")).toEqual({ label: "завдання", number: "5" });
  });

  it("returns null for a bare number (ambiguous with a page number, handled by page-jump instead)", () => {
    expect(parseNumberQuery("5")).toBeNull();
  });

  it("returns null for free text that is not a numbering convention", () => {
    expect(parseNumberQuery("Тарас Шевченко")).toBeNull();
    expect(parseNumberQuery("")).toBeNull();
  });
});

function chunk(page: number, text: string, locator: string | null = null): SearchableChunk {
  return { page, locator, text };
}

describe("searchMaterialText", () => {
  it("finds a page by a plain free-text substring, case-insensitively", () => {
    const chunks = [chunk(1, "Вступ до історії"), chunk(2, "Лічба часу в ІСТОРІЇ давніх народів")];
    const hits = searchMaterialText(chunks, "історії");
    expect(hits.map((h) => h.page)).toEqual([1, 2]);
  });

  it("finds a page by «завдання N» even when the keyword declines grammatically", () => {
    const chunks = [
      chunk(10, "Якийсь текст без завдань."),
      chunk(11, "Запитання і завдання\n5. Назви причини події.\n6. Поясни наслідки."),
    ];
    const hits = searchMaterialText(chunks, "завдання 5");
    expect(hits.map((h) => h.page)).toEqual([11]);
    expect(hits[0]!.snippet).toContain("5. Назви причини");
  });

  it("finds a page by §N even when the text only prints the numbered list item, not the word «параграф»", () => {
    const chunks = [chunk(6, "§3. Початок вивчення.\nТекст параграфа тут."), chunk(7, "Інший текст.")];
    const hits = searchMaterialText(chunks, "§3");
    expect(hits.map((h) => h.page)).toEqual([6]);
  });

  it("matches a bare numbered list item at a line start for a keyword query, not just an inline mention", () => {
    const chunks = [chunk(20, "Задачі\n12. Обчисли периметр трикутника.")];
    const hits = searchMaterialText(chunks, "задача 12");
    expect(hits.map((h) => h.page)).toEqual([20]);
  });

  it("does not cross-match a different number under the same keyword", () => {
    const chunks = [chunk(1, "Завдання 5. Текст.")];
    expect(searchMaterialText(chunks, "завдання 6")).toEqual([]);
  });

  it("returns one hit per page even if the page has several matching chunks", () => {
    const chunks = [chunk(1, "історія тут"), chunk(1, "ще раз історія тут")];
    expect(searchMaterialText(chunks, "історія")).toHaveLength(1);
  });

  it("carries the printed-page locator through for a manual-import material (ADR-031 §3.5)", () => {
    const chunks = [chunk(22, "§3. Лічба часу в історії.", "18")];
    const hits = searchMaterialText(chunks, "§3");
    expect(hits[0]).toMatchObject({ page: 22, locator: "18" });
  });

  it("skips chunks without a page number", () => {
    const chunks: SearchableChunk[] = [{ page: null, locator: null, text: "історія" }];
    expect(searchMaterialText(chunks, "історія")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchMaterialText([chunk(1, "текст")], "   ")).toEqual([]);
  });

  it("sorts hits by page ascending regardless of chunk order", () => {
    const chunks = [chunk(9, "історія"), chunk(2, "історія"), chunk(5, "історія")];
    expect(searchMaterialText(chunks, "історія").map((h) => h.page)).toEqual([2, 5, 9]);
  });
});
