import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { combineMathCourseV2Package, isConstructionTemplateAsset, parseMathCourseV2Private, parseMathCourseV2Public } from "./mathCourseV2Import";

/**
 * S35 ($0 math course-package v2 importer) — tests run against a REAL,
 * trimmed subset of the PO's actual package ("Істер, математика 6 клас,
 * частина 1, повний пакет") — `__fixtures__/math-course-v2/` (2 of 38
 * lessons: p01, p03), never invented data, same convention as
 * `courseImport.test.ts` (S34).
 */

const FIXTURES = join(__dirname, "__fixtures__", "math-course-v2");
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, path), "utf8"));
}

describe("parseMathCourseV2Public / parseMathCourseV2Private (real fixture subset)", () => {
  it("parses the trimmed public course.json with no errors", () => {
    const { data, errors } = parseMathCourseV2Public(readJson("public/course.json"));
    expect(errors).toEqual([]);
    expect(data.course?.id).toBe("ister_2023_math6_part1_v2");
    expect(data.lessons.map((l) => l.id).sort()).toEqual(["p01", "p03"]);
    expect(data.screens.length).toBe(12);
    expect(data.questions.length).toBe(4);
    expect(data.exercises.map((e) => e.id).sort()).toEqual(["p01_ex_107", "p01_ex_131", "p03_ex_193", "p03_ex_194"]);
    expect(data.assets.map((a) => a.id).sort()).toEqual(["figure_03", "p03_ex_193_ray_blank", "p03_ex_194_ray_blank"]);
  });

  // Real-import incident (2026-10-07): the real package legitimately sends
  // `certificate: null` for a question/solution part with no single
  // checkable numeric answer — the schema used to require a record, so
  // EVERY such key/part failed validation and silently vanished (171 errors,
  // 52 questions left without a working key on the real import).
  it("accepts certificate: null on a question key and a solution-part step, same as the real package sends", () => {
    const raw = readJson("private/teacher.json") as { question_keys: { certificate: unknown }[]; exercise_solutions: { parts: { certificate: unknown }[] }[] };
    raw.question_keys[0]!.certificate = null;
    raw.exercise_solutions[0]!.parts[0]!.certificate = null;

    const priv = parseMathCourseV2Private(raw);
    expect(priv.errors).toEqual([]);
    expect(priv.questionKeys[0]!.certificate).toBeNull();
    expect(priv.exerciseSolutions[0]!.parts[0]!.certificate).toBeNull();
  });

  it("parses the trimmed private teacher.json with no errors", () => {
    const priv = parseMathCourseV2Private(readJson("private/teacher.json"));
    expect(priv.errors).toEqual([]);
    expect(priv.courseId).toBe("ister_2023_math6_part1_v2");
    expect(priv.questionKeys.length).toBe(4);
    expect(priv.exerciseSolutions.length).toBe(4);
    expect(priv.sourceIssues.map((s) => s.exercise_id)).toEqual(["p01_ex_131"]);
  });

  it("NEVER exposes a correct answer anywhere in the public parse (no field, not even by accident in a stray string)", () => {
    const { data } = parseMathCourseV2Public(readJson("public/course.json"));
    const serialized = JSON.stringify({ lessons: data.lessons, screens: data.screens, questions: data.questions, exercises: data.exercises });
    expect(serialized).not.toContain("correct_option_id");
    expect(serialized).not.toMatch(/150 · 0,2 = 30/); // the real explanation text for p01_q01 — must never leak into the public side.
    // Every question object has exactly the public shape — no stray key could carry answer data through.
    for (const q of data.questions) {
      expect(Object.keys(q).sort()).toEqual(["display_md", "id", "lesson_id", "max_points", "narration", "options"].sort());
    }
  });

  it("combineMathCourseV2Package keeps source_issues (16 in the real package, 1 in this subset) and attaches them only by exercise_id, never inlined into the public exercise", () => {
    const pub = parseMathCourseV2Public(readJson("public/course.json"));
    const priv = parseMathCourseV2Private(readJson("private/teacher.json"));
    const combined = combineMathCourseV2Package(pub.data, priv);

    expect(combined.sourceIssues).toHaveLength(1);
    expect(combined.sourceIssues[0]!.exercise_id).toBe("p01_ex_131");
    expect(combined.sourceIssues[0]!.issue).toMatchObject({ automatic_grading: "blocked_until_assumption_is_stated" });

    const ex131 = combined.exercises.find((e) => e.id === "p01_ex_131");
    expect(ex131).toBeDefined();
    expect(Object.keys(ex131!)).not.toContain("issue");
    expect(Object.keys(ex131!)).not.toContain("source_issue");
  });

  it("combineMathCourseV2Package links every question to its key by question_id and warns (not throws) on a mismatch", () => {
    const pub = parseMathCourseV2Public(readJson("public/course.json"));
    const priv = parseMathCourseV2Private(readJson("private/teacher.json"));

    // Simulate a private file whose key points at a question that doesn't exist in this public subset.
    const brokenPriv = { ...priv, questionKeys: [...priv.questionKeys, { ...priv.questionKeys[0]!, id: "ghost_key", question_id: "does_not_exist" }] };
    const combined = combineMathCourseV2Package(pub.data, brokenPriv);

    expect(combined.questionKeys.find((k) => k.id === "ghost_key")).toBeUndefined();
    expect(combined.questionKeys).toHaveLength(priv.questionKeys.length);
    expect(combined.warnings.some((w) => w.field === "question_keys.ghost_key")).toBe(true);
  });

  it("combineMathCourseV2Package warns when a public question has no private key at all", () => {
    const pub = parseMathCourseV2Public(readJson("public/course.json"));
    const priv = parseMathCourseV2Private(readJson("private/teacher.json"));
    const withoutOneKey = { ...priv, questionKeys: priv.questionKeys.filter((k) => k.question_id !== "p01_q01") };
    const combined = combineMathCourseV2Package(pub.data, withoutOneKey);

    expect(combined.warnings.some((w) => w.message.includes('"p01_q01"'))).toBe(true);
  });
});

describe("isConstructionTemplateAsset", () => {
  it("flags the real _blank asset ids (printable construction templates) and not ordinary figures", () => {
    expect(isConstructionTemplateAsset("p03_ex_193_ray_blank")).toBe(true);
    expect(isConstructionTemplateAsset("p05_ex_275_crossword_blank")).toBe(true);
    expect(isConstructionTemplateAsset("figure_03")).toBe(false);
  });
});
