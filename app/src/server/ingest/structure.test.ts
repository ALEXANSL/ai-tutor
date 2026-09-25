import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOutline,
  buildStructureSchema,
  fillTemplate,
  isHeadingLike,
  mergeByTitle,
  narrowestContaining,
  normalizeSections,
  splitPrompt,
} from "./structure";

describe("structure prompt", () => {
  const file = readFileSync(join(__dirname, "../../../prompts/indexing_structure.md"), "utf8");

  it("has a system and a user part with all placeholders", () => {
    const { system, user } = splitPrompt(file);
    expect(system).toMatch(/Нічого не вигадуй/);
    for (const k of ["file_name", "meta_title", "grade_hint", "kinds", "subjects", "existing_topics", "toc", "outline"]) {
      expect(user).toContain(`{{${k}}}`);
    }
    expect(system + user).not.toMatch(/\{\{nickname\}\}/); // no child data (NFR-PRIV-2)
  });

  it("fills placeholders and leaves unknown ones", () => {
    expect(fillTemplate("{{a}} і {{b}}", { a: "x" })).toBe("x і {{b}}");
  });
});

describe("outline for the model", () => {
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

describe("schema", () => {
  it("accepts only registered kinds and subjects (or none)", () => {
    const schema = buildStructureSchema(["textbook", "reference"], ["math"]);
    const ok = {
      title: "Т",
      kind: "textbook",
      subject_code: "none",
      grade: null,
      sections: [],
      dependencies: [],
      related_topics: [],
    };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, kind: "novel" }).success).toBe(false);
    expect(schema.safeParse({ ...ok, subject_code: "physics" }).success).toBe(false);
  });
});

describe("normalizeSections", () => {
  const answer = {
    sections: [
      {
        title: " Розділ 1. Дроби ",
        page_from: 5,
        page_to: null,
        topics: [
          { title: "Поняття дробу", page_from: 5, page_to: null },
          { title: "Скорочення дробів", page_from: 12, page_to: 18 },
        ],
      },
      { title: "Розділ 2. Відсотки", page_from: 30, page_to: 999, topics: [{ title: "", page_from: 1, page_to: 1 }] },
    ],
  };

  it("fills missing ranges, clamps pages and drops empty titles (textbook)", () => {
    const res = normalizeSections(answer, "textbook", 120);
    expect(res.map((s) => [s.title, s.page_from, s.page_to])).toEqual([
      ["Розділ 1. Дроби", 5, 29],
      ["Розділ 2. Відсотки", 30, 120],
    ]);
    expect(res[0]!.topics).toEqual([
      { title: "Поняття дробу", page_from: 5, page_to: 11 },
      { title: "Скорочення дробів", page_from: 12, page_to: 18 },
    ]);
    expect(res[1]!.topics).toEqual([]);
  });

  it("drops topics for non-textbook strategies (ADR-017)", () => {
    expect(normalizeSections(answer, "chapters", 120).every((s) => s.topics.length === 0)).toBe(true);
    expect(normalizeSections(answer, "contents", 120)).toHaveLength(2);
  });
});

describe("mergeByTitle (US-2.2 KP-2: manual fixes survive re-indexing)", () => {
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
