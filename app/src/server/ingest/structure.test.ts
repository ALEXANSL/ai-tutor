import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOutline,
  buildOutlineSchema,
  buildSectionSchema,
  buildSectionText,
  fillTemplate,
  isHeadingLike,
  mergeByTitle,
  narrowestContaining,
  narrowestTitleFor,
  normalizeOutlineSections,
  normalizeProblems,
  normalizeSectionTopics,
  splitPrompt,
} from "./structure";

describe("indexing_outline prompt (ADR-032 pass 1)", () => {
  const file = readFileSync(join(__dirname, "../../../prompts/indexing_outline.md"), "utf8");

  it("has a system and a user part with all placeholders", () => {
    const { system, user } = splitPrompt(file);
    expect(system).toMatch(/Нічого не вигадуй/);
    for (const k of ["file_name", "meta_title", "grade_hint", "kinds", "subjects", "toc", "outline"]) {
      expect(user).toContain(`{{${k}}}`);
    }
    expect(system + user).not.toMatch(/\{\{nickname\}\}/); // no child data (NFR-PRIV-2)
  });
});

describe("indexing_structure prompt (ADR-032 pass 2 — per section)", () => {
  const file = readFileSync(join(__dirname, "../../../prompts/indexing_structure.md"), "utf8");

  it("has a system and a user part with all placeholders", () => {
    const { system, user } = splitPrompt(file);
    expect(system).toMatch(/Нічого не вигадуй/);
    for (const k of ["file_name", "meta_title", "kind_title", "section_title", "section_range", "existing_topics", "section_text"]) {
      expect(user).toContain(`{{${k}}}`);
    }
    expect(system + user).not.toMatch(/\{\{nickname\}\}/); // no child data (NFR-PRIV-2)
  });
});

describe("fillTemplate", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(fillTemplate("{{a}} і {{b}}", { a: "x" })).toBe("x і {{b}}");
  });
});

describe("outline for the model (pass 1 input, unchanged by ADR-032)", () => {
  const pages = Array.from({ length: 40 }, (_, i) => ({
    page: i + 1,
    locator: null,
    text: `Розділ ${i + 1}. ДРОБИ\n§ ${i + 1} Скорочення дробів\n${"Текст пояснення ".repeat(60)}`,
  }));

  it("keeps full edge pages and headings of the middle pages", () => {
    const out = buildOutline(pages, { edgePages: 2 });
    expect(out).toContain("--- Стор. 1 ---");
    expect(out).toContain("# § 20 Скорочення дробів");
    expect(out.length).toBeLessThan(pages.reduce((n, p) => n + p.text.length, 0));
  });

  it("respects the size limit", () => {
    expect(buildOutline(pages, { maxChars: 5000 }).length).toBeLessThanOrEqual(5000);
  });

  it("recognises heading-like lines", () => {
    expect(isHeadingLike("§ 12. Додавання дробів")).toBe(true);
    expect(isHeadingLike("Розділ 2 Десяткові дроби")).toBe(true);
    expect(isHeadingLike("ДІЛЕННЯ ДРОБІВ")).toBe(true);
    expect(isHeadingLike("звичайне речення з тексту підручника, яке нічим не виділене")).toBe(false);
  });
});

describe("buildSectionText (ADR-032 pass 2 input): full, UNCOMPRESSED text of one section", () => {
  it("renders every page's full text, never truncated", () => {
    const longText = "Текст пояснення ".repeat(500); // would have been cut by buildOutline
    const pages = [
      { page: 5, locator: null, text: longText },
      { page: 6, locator: "розд. 2", text: "Другий текст" },
    ];
    const out = buildSectionText(pages);
    expect(out).toContain("--- Стор. 5 ---");
    expect(out).toContain(longText);
    expect(out).toContain("--- Стор. 6 (розд. 2) ---");
    expect(out).toContain("Другий текст");
  });
});

describe("buildOutlineSchema (pass 1): section boundaries only", () => {
  it("accepts only registered kinds and subjects (or none), no topics/problems fields", () => {
    const schema = buildOutlineSchema(["textbook", "reference"], ["math"]);
    const ok = { title: "Т", kind: "textbook", subject_code: "none", grade: null, sections: [{ title: "Розділ 1", page_from: 1, page_to: 10 }] };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, kind: "novel" }).success).toBe(false);
    expect(schema.safeParse({ ...ok, subject_code: "physics" }).success).toBe(false);
  });
});

describe("buildSectionSchema (pass 2): one section's topics/problems/dependencies/related_topics", () => {
  it("accepts a well-formed answer", () => {
    const schema = buildSectionSchema();
    const ok = {
      topics: [{ title: "Тема", page_from: 1, page_to: 3 }],
      dependencies: [{ topic: "Тема 2", depends_on: "Тема 1" }],
      related_topics: ["t1"],
      problems: [{ number: "117", page: 4 }],
    };
    expect(schema.safeParse(ok).success).toBe(true);
  });

  it("caps problems at 500 (same ceiling as before ADR-032, now per section — never reached in practice)", () => {
    const schema = buildSectionSchema();
    const tooMany = { topics: [], dependencies: [], related_topics: [], problems: Array.from({ length: 501 }, (_, i) => ({ number: String(i), page: 1 })) };
    expect(schema.safeParse(tooMany).success).toBe(false);
  });
});

describe("normalizeOutlineSections (ADR-032 pass 1)", () => {
  const answer = {
    sections: [
      { title: " Розділ 1. Дроби ", page_from: 5, page_to: null },
      { title: "Розділ 2. Відсотки", page_from: 30, page_to: 999 },
      { title: "", page_from: 1, page_to: 1 },
    ],
  };

  it("fills missing ranges, clamps pages and drops empty titles", () => {
    expect(normalizeOutlineSections(answer, 120)).toEqual([
      { title: "Розділ 1. Дроби", page_from: 5, page_to: 29 },
      { title: "Розділ 2. Відсотки", page_from: 30, page_to: 120 },
    ]);
  });
});

describe("normalizeSectionTopics (ADR-032 pass 2, scoped to ONE section)", () => {
  const answer = {
    topics: [
      { title: "Поняття дробу", page_from: 5, page_to: null },
      { title: "Скорочення дробів", page_from: 12, page_to: 18 },
    ],
  };

  it("fills missing page_to from the SECTION's own upper bound, not the whole book", () => {
    const res = normalizeSectionTopics(answer, "textbook", 500, 18);
    expect(res).toEqual([
      { title: "Поняття дробу", page_from: 5, page_to: 11 },
      { title: "Скорочення дробів", page_from: 12, page_to: 18 },
    ]);
  });

  it("drops topics for non-textbook strategies (ADR-017)", () => {
    expect(normalizeSectionTopics(answer, "chapters", 500, 18)).toEqual([]);
    expect(normalizeSectionTopics(answer, "contents", 500, 18)).toEqual([]);
  });
});

describe("normalizeProblems (ADR-029, US-2.8; ADR-032: per-section input, same rules)", () => {
  it("gates on strategy === textbook", () => {
    const answer = { problems: [{ number: "117", page: 42 }] };
    expect(normalizeProblems(answer, "chapters", 120)).toEqual([]);
    expect(normalizeProblems(answer, "contents", 120)).toEqual([]);
    expect(normalizeProblems(answer, "textbook", 120)).toEqual([{ number: "117", page: 42 }]);
  });

  it("drops a number with no page, an out-of-range page is clamped, and whitespace-containing numbers are dropped (КП-2: never invent)", () => {
    const answer = {
      problems: [
        { number: "117", page: null },
        { number: "118", page: 9999 },
        { number: "9 7", page: 10 },
        { number: "  119  ", page: 5 },
      ],
    };
    expect(normalizeProblems(answer, "textbook", 120)).toEqual([
      { number: "118", page: 120 },
      { number: "119", page: 5 },
    ]);
  });

  it("dedupes the same page+number seen twice, keeping the first display casing", () => {
    const answer = {
      problems: [
        { number: "117а", page: 42 },
        { number: "117А", page: 42 },
      ],
    };
    expect(normalizeProblems(answer, "textbook", 120)).toEqual([{ number: "117а", page: 42 }]);
  });
});

describe("mergeByTitle (US-2.2 KP-2: manual fixes survive re-indexing; ADR-032: callers scope `existing` per-section for topics)", () => {
  it("updates automatic rows, keeps manual rows, deletes stale automatic rows", () => {
    const existing = [
      { id: "a", title: "Поняття дробу", manual_override: false },
      { id: "b", title: "Скорочення дробів.", manual_override: true },
      { id: "c", title: "Стара тема", manual_override: false },
      { id: "d", title: "Тема тата", manual_override: true },
    ];
    const { plan, remove } = mergeByTitle(existing, [
      { title: "поняття  дробу" },
      { title: "Скорочення дробів" },
      { title: "Нова тема" },
    ]);
    expect(plan).toEqual([
      { action: "update", id: "a" },
      { action: "keep", id: "b" },
      { action: "insert", id: null },
    ]);
    expect(remove).toEqual(["c"]);
  });
});

describe("narrowestContaining", () => {
  it("assigns a page to the most specific range", () => {
    const items = [
      { id: "section", page_from: 5, page_to: 29 },
      { id: "topic", page_from: 12, page_to: 18 },
      { id: "open", page_from: null, page_to: null },
    ];
    expect(narrowestContaining(14, items)).toBe("topic");
    expect(narrowestContaining(6, items)).toBe("section");
    expect(narrowestContaining(40, items)).toBeNull();
    expect(narrowestContaining(null, items)).toBeNull();
  });
});

describe("narrowestTitleFor (D-106)", () => {
  const items = [
    { id: "section", title: "Розділ 1", page_from: 5, page_to: 29 },
    { id: "topic", title: "Дроби", page_from: 12, page_to: 18 },
  ];

  it("returns the narrowest range's title when the page falls inside one", () => {
    expect(narrowestTitleFor(14, items)).toBe("Дроби");
    expect(narrowestTitleFor(6, items)).toBe("Розділ 1");
  });

  it("falls back to null when the page is outside every indexed range", () => {
    expect(narrowestTitleFor(40, items)).toBeNull();
    expect(narrowestTitleFor(null, items)).toBeNull();
  });
});
