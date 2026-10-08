import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { combineLiteratureV2Package, parseLiteratureV2Assets, parseLiteratureV2Course, parseLiteratureV2TaskTables, parseLiteratureV2Teacher } from "./literatureV2Import";

/**
 * S36 ($0 foreign-literature course-package v2 importer) — tests run
 * against a REAL, trimmed subset of the PO's actual package ("Зарубіжна
 * література, 6 клас", Літера ЛТД, 2023) — `__fixtures__/literature-course-
 * v2/` (3 of 53 lessons: L001, L002, L004 — chosen so the subset includes a
 * task_table), never invented data, same convention as
 * `mathCourseV2Import.test.ts` (S35).
 */

const FIXTURES = join(__dirname, "__fixtures__", "literature-course-v2");
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, path), "utf8"));
}

describe("literatureV2Import (real fixture subset)", () => {
  it("parses the trimmed public course.json with no errors", () => {
    const result = parseLiteratureV2Course(readJson("public/course.json"));
    expect(result.errors).toEqual([]);
    expect(result.bookId).toBe("zarlit6-kovbasenko-2023");
    expect(result.lessons.map((l) => l.id).sort()).toEqual(["zarlit6-kovbasenko-2023-L001", "zarlit6-kovbasenko-2023-L002", "zarlit6-kovbasenko-2023-L004"]);
    expect(result.tasks.length).toBe(25);
    // Every single task in this package is open-response — no correct
    // option anywhere to grade automatically.
    expect(result.tasks.every((t) => t.auto_grade === false)).toBe(true);
  });

  it("parses the trimmed private teacher.json with no errors", () => {
    const result = parseLiteratureV2Teacher(readJson("private/teacher.json"));
    expect(result.errors).toEqual([]);
    expect(result.taskKeys.length).toBe(25);
    expect(result.taskKeys.every((k) => k.hints.length > 0 || k.answer)).toBe(true);
  });

  it("parses catalog/assets.json, skipping the task_table-kind entries (a redundant copy of task_tables.json, not an illustration)", () => {
    const result = parseLiteratureV2Assets(readJson("catalog/assets.json"));
    expect(result.errors).toEqual([]);
    expect(result.assets.length).toBe(6);
    for (const a of result.assets) expect(a.path).toMatch(/^assets\/illustrations\//);
  });

  it("parses catalog/task_tables.json with no errors", () => {
    const result = parseLiteratureV2TaskTables(readJson("catalog/task_tables.json"));
    expect(result.errors).toEqual([]);
    expect(result.taskTables.length).toBe(1);
    expect(result.taskTables[0]!.empty_cells_are_student_input).toBe(true);
  });

  it("NEVER exposes a hint/model-answer/criterion anywhere in the public parse", () => {
    const result = parseLiteratureV2Course(readJson("public/course.json"));
    const serialized = JSON.stringify({ lessons: result.lessons, tasks: result.tasks });
    expect(serialized).not.toContain("criterion");
    expect(serialized).not.toContain("acceptable_alternatives");
    expect(serialized).not.toContain("student_pattern"); // misconception field name, private-only
    for (const t of result.tasks) {
      expect(Object.keys(t).sort()).toEqual(
        ["asset_refs", "auto_grade", "id", "lesson_id", "original_label", "prompt", "required_inputs", "response_type", "source", "source_kind", "subtasks"].sort(),
      );
    }
  });

  it("combineLiteratureV2Package cross-checks referential integrity with no warnings on this consistent subset", () => {
    const course = parseLiteratureV2Course(readJson("public/course.json"));
    const teacher = parseLiteratureV2Teacher(readJson("private/teacher.json"));
    const assets = parseLiteratureV2Assets(readJson("catalog/assets.json"));
    const taskTables = parseLiteratureV2TaskTables(readJson("catalog/task_tables.json"));
    const combined = combineLiteratureV2Package(course, teacher, assets, taskTables);

    expect(combined.warnings).toEqual([]);
    expect(combined.taskKeys).toHaveLength(25);
    expect(combined.taskTables).toHaveLength(1);
  });

  it("drops a key/table whose task_id doesn't exist in this subset, with a warning instead of a thrown error", () => {
    const course = parseLiteratureV2Course(readJson("public/course.json"));
    const teacher = parseLiteratureV2Teacher(readJson("private/teacher.json")) as ReturnType<typeof parseLiteratureV2Teacher>;
    teacher.taskKeys = [...teacher.taskKeys, { ...teacher.taskKeys[0]!, task_id: "no-such-task" }];
    const assets = parseLiteratureV2Assets(readJson("catalog/assets.json"));
    const taskTables = parseLiteratureV2TaskTables(readJson("catalog/task_tables.json"));
    const combined = combineLiteratureV2Package(course, teacher, assets, taskTables);

    expect(combined.taskKeys).toHaveLength(25); // the bogus one filtered out
    expect(combined.warnings.some((w) => w.message.includes("no-such-task"))).toBe(true);
  });
});
