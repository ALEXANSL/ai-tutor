import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseLessonMarkdown, parseLiteratureCourseZip, parseTestJson } from "./literatureImport";

/**
 * S33 follow-up ($0 manual-course importer, PO decision 2026-09-30): tests
 * run against REAL sample files from the PO's own reference course
 * (`__fixtures__/zarlit-6/`, copied verbatim from a Claude Opus-authored
 * example he plans to reuse as-is) — never invented fixtures — so the
 * parser is proven against the actual format, not a guess at it.
 */

const FIXTURES = join(__dirname, "__fixtures__", "zarlit-6");
function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function zipFixtureCourse(): Uint8Array {
  return zipSync({
    "README.md": strToU8(readFixture("README.md")),
    "course_index.json": strToU8(readFixture("course_index.json")),
    "lessons/01.md": strToU8(readFixture("lessons/01.md")),
    "lessons/03.md": strToU8(readFixture("lessons/03.md")),
    "lessons/05.md": strToU8(readFixture("lessons/05.md")),
    "tests/01.json": strToU8(readFixture("tests/01.json")),
    "tests/03.json": strToU8(readFixture("tests/03.json")),
    "tests/05.json": strToU8(readFixture("tests/05.json")),
  });
}

describe("parseFrontmatter", () => {
  it("reads strings, numbers, and number arrays from the real lesson 05 frontmatter", () => {
    const { data, body } = parseFrontmatter(readFixture("lessons/05.md"));
    expect(data.id).toBe("zarlit6-05");
    expect(data.subject).toBe("Зарубіжна література");
    expect(data.grade).toBe(6);
    expect(data.topic).toBe(5);
    expect(data.textbook_pages).toEqual([36, 75]);
    expect(data.pdf_pages).toEqual([37, 76]);
    expect(data.test_file).toBe("tests/05.json");
    expect(body).toContain("# Тема 5. Даніель Дефо");
  });
});

describe("parseLessonMarkdown (real fixtures)", () => {
  it("parses lesson 01 — a theory-only topic with no ## Твір section", () => {
    const warnings: string[] = [];
    const topic = parseLessonMarkdown(readFixture("lessons/01.md"), (f, m) => warnings.push(`${f}: ${m}`));

    expect(topic.topicNo).toBe(1);
    expect(topic.sectionTitleUk).toBe("Вступ");
    expect(topic.titleUk).toBe("Художня література і мистецтво. Роль перекладу");
    expect(topic.textbookPageFrom).toBe(4);
    expect(topic.textbookPageTo).toBe(9);
    expect(topic.pdfPageFrom).toBe(5);
    expect(topic.pdfPageTo).toBe(10);
    expect(topic.goalUk).toContain("художнього перекладу");
    expect(topic.keyConceptsUk.length).toBeGreaterThanOrEqual(4);
    expect(topic.keyConceptsUk[0]).toContain("Мистецтво");
    expect(topic.explanationMdUk).toContain("Кам’яна Могила");
    expect(topic.work).toBeNull(); // no "## Твір" in this topic — never invented
    expect(topic.teacherNoteUk).toContain("Який вид мистецтва тобі найближчий");

    expect(topic.sublessons).toHaveLength(2);
    expect(topic.sublessons[0]).toMatchObject({ no: "1.1", titleUk: "Художня література і мистецтво" });
    expect(topic.sublessons[0]!.questionGroups).toHaveLength(2);
    expect(topic.sublessons[0]!.questionGroups[0]).toMatchObject({ labelUk: "Запитання і завдання", page: 7, pdfPage: 8 });
    expect(topic.sublessons[0]!.questionGroups[0]!.items).toHaveLength(7);
    expect(topic.sublessons[0]!.questionGroups[0]!.items[0]).toEqual({
      number: "1",
      textUk: "Яку роль мистецтво (зокрема література) мало в житті давньої людини і чи потрібне воно сьогодні?",
    });
    expect(topic.sublessons[0]!.questionGroups[1]).toMatchObject({ labelUk: "Працюємо вдома", page: 7, pdfPage: 8 });
    expect(topic.sublessons[1]).toMatchObject({ no: "1.2", titleUk: "Роль перекладачів" });

    // No fabricated work data, so no work-related warning for this topic.
    expect(warnings.some((w) => w.includes("work"))).toBe(false);
  });

  it("parses lesson 05 — a work-bearing topic with 4 sub-lessons, and flags the missing excerpt", () => {
    const warnings: string[] = [];
    const topic = parseLessonMarkdown(readFixture("lessons/05.md"), (f, m) => warnings.push(`${f}: ${m}`));

    expect(topic.titleUk).toBe("Даніель Дефо. «Пригоди Робінзона Крузо»");
    expect(topic.work).not.toBeNull();
    expect(topic.work!.titleUk).toBe("Пригоди Робінзона Крузо"); // pulled from the «quoted» part of the title
    expect(topic.work!.summaryUk).toContain("безлюдному острові");
    expect(topic.work!.charactersUk).toContain("П’ятниця");
    expect(topic.work!.ideaUk).toContain("Праця, розум, терпіння");
    // The reference format never includes a real quoted excerpt (copyright) — our schema still
    // requires a non-empty excerptsUk, so a placeholder is used and flagged.
    expect(topic.work!.excerptsUk).toContain("с. 36–75");
    expect(warnings.some((w) => w.startsWith("work.excerptsUk"))).toBe(true);

    expect(topic.sublessons).toHaveLength(4);
    expect(topic.sublessons.map((s) => s.no)).toEqual(["5.1", "5.2", "5.3", "5.4"]);
    expect(topic.sublessons[1]!.questionGroups[0]!.items).toHaveLength(7);
    expect(topic.sublessons[3]!.questionGroups).toHaveLength(2); // "Запитання і завдання" + "Працюємо вдома"
  });
});

describe("parseTestJson (real fixtures)", () => {
  it("maps lesson 01's test: single/multiple/truefalse/match/open, with missing explanations flagged", () => {
    const warnings: string[] = [];
    const test = parseTestJson(readFixture("tests/01.json"), 1, (f, m) => warnings.push(`${f}: ${m}`));

    expect(test.questions).toHaveLength(7);
    const [q1, q2, , q4, q5, , q7] = test.questions;
    expect(q1).toMatchObject({ id: "01-q1", type: "single", answer: 1 });
    expect(q2).toMatchObject({ id: "01-q2", type: "multiple", answer: [0, 1, 3] });
    expect(q4).toMatchObject({ id: "01-q4", type: "truefalse", answer: 1 });
    // "match" — left/right/answer-object source shape converted to pairs.
    expect(q5!.type).toBe("match");
    expect(q5!.pairs).toEqual([
      { leftUk: "Архітектура", rightUk: "просторове" },
      { leftUk: "Музика", rightUk: "часове" },
      { leftUk: "Хореографія", rightUk: "синтетичне" },
    ]);
    // "open" — no fixed answer, only an explanation.
    expect(q7).toMatchObject({ id: "01-q7", type: "open" });
    expect(q7!.explanationUk).toBeTruthy();

    // Only q5 ("match") lacks an explanation in this fixture; it still gets a usable placeholder.
    expect(warnings).toEqual(["test.questions[4].explanationUk: пояснення відповіді відсутнє у джерелі — використано типове формулювання"]);
    expect(q5!.explanationUk).toBeTruthy();
  });

  it("maps an 'order' question (from lesson 04's real test, embedded here) to options+answer", () => {
    const raw = JSON.stringify({
      questions: [
        {
          id: "04-q6",
          type: "order",
          question: "Розташуйте подвиги в порядку виконання.",
          items: ["Немейський лев", "Лернейська гідра", "Авгієві стайні", "Кербер"],
          answer: ["Немейський лев", "Лернейська гідра", "Авгієві стайні", "Кербер"],
        },
        { id: "04-q7", type: "single", question: "Q", options: ["a", "b"], answer: 0 },
        { id: "04-q8", type: "single", question: "Q2", options: ["a", "b"], answer: 1 },
      ],
    });
    const warnings: string[] = [];
    const test = parseTestJson(raw, 4, (f, m) => warnings.push(`${f}: ${m}`));
    expect(test.questions[0]).toMatchObject({
      type: "order",
      options: ["Немейський лев", "Лернейська гідра", "Авгієві стайні", "Кербер"],
      answer: ["Немейський лев", "Лернейська гідра", "Авгієві стайні", "Кербер"],
    });
    // Missing explanations on all three questions get a generic placeholder + a warning each.
    expect(test.questions.every((q) => q.explanationUk.length > 0)).toBe(true);
    expect(warnings.filter((w) => w.includes("explanationUk"))).toHaveLength(3);
  });

  it("pads a test with fewer than 3 usable questions and warns", () => {
    const raw = JSON.stringify({ questions: [{ id: "x-q1", type: "single", question: "Q", options: ["a", "b"], answer: 0, explanation: "e" }] });
    const warnings: string[] = [];
    const test = parseTestJson(raw, 9, (f, m) => warnings.push(`${f}: ${m}`));
    expect(test.questions.length).toBeGreaterThanOrEqual(3);
    expect(warnings.some((w) => w.startsWith("test.questions:"))).toBe(true);
  });

  it("never throws on invalid JSON — returns an empty test and a warning", () => {
    const warnings: string[] = [];
    const test = parseTestJson("{not json", 1, (f, m) => warnings.push(`${f}: ${m}`));
    expect(test.questions).toEqual([]);
    expect(warnings[0]).toContain("test");
  });
});

describe("parseLiteratureCourseZip (end-to-end, real fixtures zipped)", () => {
  it("parses all 3 fixture lessons in order, each with a matching test", () => {
    const { topics, warnings } = parseLiteratureCourseZip(zipFixtureCourse());

    expect(topics.map((t) => t.topicNo)).toEqual([1, 3, 5]);
    expect(topics[0]!.test.questions).toHaveLength(7);
    expect(topics[1]!.test.questions.length).toBeGreaterThanOrEqual(3);
    expect(topics[2]!.titleUk).toBe("Даніель Дефо. «Пригоди Робінзона Крузо»");

    // Every topic's own excerpt-placeholder warning is scoped to ITS topicNo, never mixed up.
    const excerptWarnings = warnings.filter((w) => w.field === "work.excerptsUk");
    expect(excerptWarnings.map((w) => w.topicNo).sort()).toEqual([3, 5]); // topic 1 has no "## Твір" at all
  });

  it("matches tests/NN.json by the frontmatter's own test_file path, not just by number guessing", () => {
    const zip = zipSync({
      "lessons/01.md": strToU8(readFixture("lessons/01.md").replace("tests/01.json", "custom/renamed-test.json")),
      "custom/renamed-test.json": strToU8(readFixture("tests/01.json")),
    });
    const { topics, warnings } = parseLiteratureCourseZip(zip);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.test.questions).toHaveLength(7);
    expect(warnings.some((w) => w.field === "test")).toBe(false);
  });

  it("still produces a topic (with a placeholder test + warning) when the test file is missing entirely", () => {
    const zip = zipSync({ "lessons/01.md": strToU8(readFixture("lessons/01.md")) });
    const { topics, warnings } = parseLiteratureCourseZip(zip);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.test.questions.length).toBeGreaterThanOrEqual(3);
    expect(warnings.some((w) => w.field === "test" && w.topicNo === 1)).toBe(true);
  });

  it("returns an empty result with a course-level warning for a zip with no lessons/ files", () => {
    const zip = zipSync({ "README.md": strToU8("hello") });
    const { topics, warnings } = parseLiteratureCourseZip(zip);
    expect(topics).toEqual([]);
    expect(warnings).toEqual([{ topicNo: null, field: "lessons", message: expect.stringContaining("lessons/NN.md") }]);
  });

  it("also works when the zip wraps everything in a top-level course folder (common zip-tool behavior)", () => {
    const zip = zipSync({
      "zarlit-6/lessons/03.md": strToU8(readFixture("lessons/03.md")),
      "zarlit-6/tests/03.json": strToU8(readFixture("tests/03.json")),
    });
    const { topics } = parseLiteratureCourseZip(zip);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.topicNo).toBe(3);
    expect(topics[0]!.test.questions.length).toBeGreaterThan(0);
  });
});
