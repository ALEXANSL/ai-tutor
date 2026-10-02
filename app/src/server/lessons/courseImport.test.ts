import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  parseCourseExercise,
  parseCourseLesson,
  parseCoursePackageZip,
  parseCourseTest,
} from "./courseImport";

/**
 * S34 ($0 course-package importer): tests run against REAL sample files
 * from the PO's own prepared package ("Математика, Істер, 2023, частина 1")
 * — `__fixtures__/ister-math6-part1/` — never invented
 * fixtures, per the PO's own instruction for this feature.
 *
 * The fixtures folder deliberately holds only a REPRESENTATIVE SUBSET of
 * the real package's files (3 of 37 lessons, 2 of 2 webp assets, etc. —
 * see the folder's place in the orchestrator's brief): `manifest.json`
 * itself is the real, COMPLETE manifest (listing all 37 lessons), so
 * zipping the fixtures folder as-is is simultaneously a realistic test of
 * (a) correctly parsing the lessons/tests/assets that ARE present and
 * (b) correctly reporting — never silently dropping — the ones that are
 * NOT (because this subset, not because the real package is broken).
 */

const FIXTURES = join(__dirname, "__fixtures__", "ister-math6-part1");
function readFixture(path: string): Buffer {
  return readFileSync(join(FIXTURES, path));
}

function zipWholeFixture(): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const relPaths = [
    "manifest.json",
    "lessons/p01.json",
    "lessons/homework_1.json",
    "lessons/review_1.json",
    "tests/p01.json",
    "tests/homework_1.json",
    "exercises.sample.jsonl",
    "assets/fragments/p01_theory_p016.webp",
    "assets/figures/figure_01.webp",
  ];
  for (const rel of relPaths) files[rel] = new Uint8Array(readFixture(rel));
  return zipSync(files);
}

describe("parseCoursePackageZip (real ister-math6-part1 fixtures)", () => {
  it("parses the manifest and every lesson/test file actually present in the archive", () => {
    const result = parseCoursePackageZip(zipWholeFixture());

    expect(result.manifest).not.toBeNull();
    expect(result.manifest?.id).toBe("ister_2023_math6_part1");
    expect(result.manifest?.lessonFiles.length).toBe(38);

    // Only the 3 lessons actually in the zip parse successfully.
    const lessonKeys = result.lessons.map((l) => l.lessonKey).sort();
    expect(lessonKeys).toEqual(["homework_1", "p01", "review_1"]);

    // The other lesson_files entries (not present in this representative
    // subset) are reported, never silently dropped.
    const missingLessonErrors = result.errors.filter((e) => e.file !== "manifest.json" && e.file?.startsWith("lessons/"));
    expect(missingLessonErrors.length).toBe(35);
    expect(missingLessonErrors[0]?.message).toContain("файл відсутній у архіві");
  });

  it("parses p01's real theory content (math LaTeX, 4 source_material images, exercise_ids, test_path)", () => {
    const result = parseCoursePackageZip(zipWholeFixture());
    const p01 = result.lessons.find((l) => l.lessonKey === "p01");
    expect(p01).toBeDefined();
    expect(p01?.kind).toBe("lesson");
    expect(p01?.order).toBe(4);
    expect(p01?.title).toBe("Відсотки. Знаходження відсотків від числа");
    expect(p01?.teacherNotesMd).toContain("\\frac{1}{100}");
    expect(p01?.sourceMaterial).toHaveLength(4);
    expect(p01?.sourceMaterial[0]?.assetId).toBe("p01_theory_p016");
    expect(p01?.sourceMaterial[0]?.path).toBe("assets/fragments/p01_theory_p016.webp");
    expect(p01?.sourceMaterial[0]?.textStatus).toBe("unverified_ocr");
    expect(p01?.exerciseIds).toHaveLength(48);
    expect(p01?.testPath).toBe("tests/p01.json");
    expect(p01?.needsReview).toBe(false);
  });

  it("parses review/assessment kinds correctly", () => {
    const result = parseCoursePackageZip(zipWholeFixture());
    expect(result.lessons.find((l) => l.lessonKey === "review_1")?.kind).toBe("review");
    expect(result.lessons.find((l) => l.lessonKey === "homework_1")?.kind).toBe("assessment");
  });

  it("marks review_1 needs_review and warns — its test file (tests/review_1.json) is genuinely absent from the fixture subset", () => {
    const result = parseCoursePackageZip(zipWholeFixture());
    const review1 = result.lessons.find((l) => l.lessonKey === "review_1");
    expect(review1?.needsReview).toBe(true);
    expect(result.testsByLessonKey.has("review_1")).toBe(false);
    const w = result.warnings.find((x) => x.file === "tests/review_1.json");
    expect(w).toBeDefined();
    expect(w?.message).toContain("не знайдено");
  });

  it("parses p01's real test: 5 single_choice automatic_questions with verified correct_option_id/explanation", () => {
    const result = parseCoursePackageZip(zipWholeFixture());
    const test = result.testsByLessonKey.get("p01");
    expect(test).toBeDefined();
    expect(test?.automaticQuestions).toHaveLength(5);
    const q1 = test!.automaticQuestions[0]!;
    expect(q1.promptMd).toBe("Запиши 7 % десятковим дробом.");
    expect(q1.options).toHaveLength(4);
    expect(q1.correctOptionId).toBe("C");
    expect(q1.options.find((o) => o.id === "C")?.textMd).toBe("0,07");
    expect(test?.automaticMaxPoints).toBe(5);
  });

  it("parses the real exercises.sample.jsonl (5 reference-only open_response exercises)", () => {
    const result = parseCoursePackageZip(zipWholeFixture());
    expect(result.exercises).toHaveLength(5);
    const ex1 = result.exercises[0]!;
    expect(ex1.exerciseKey).toBe("review_5_ex_001");
    expect(ex1.originalNumber).toBe("1");
    expect(ex1.responseType).toBe("open_response");
    expect(ex1.grading).toEqual({ mode: "manual_or_tutor_review", answerKey: null });
    expect(ex1.content).toHaveLength(1);
    expect(ex1.content[0]?.path).toBe("assets/fragments/review_5_ex_001_p005.webp");
  });

  it("collects the asset files actually present in the zip, keyed by their zip-relative path", () => {
    const result = parseCoursePackageZip(zipWholeFixture());
    expect(result.assetFiles.has("assets/fragments/p01_theory_p016.webp")).toBe(true);
    expect(result.assetFiles.has("assets/figures/figure_01.webp")).toBe(true);
    expect(result.assetFiles.size).toBe(2);
  });

  it("has no assets/index.json in this subset, so assetIndex is empty but parsing still succeeds (optional data, brief: don't block on it)", () => {
    const result = parseCoursePackageZip(zipWholeFixture());
    expect(result.assetIndex.size).toBe(0);
    expect(result.manifest).not.toBeNull();
  });

  it("fails cleanly (package-level error, no throw) on a zip with no manifest.json", () => {
    const result = parseCoursePackageZip(zipSync({ "readme.txt": new Uint8Array() }));
    expect(result.manifest).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe("manifest.json");
  });
});

describe("parseCourseLesson — required-field rejection (never invents a value)", () => {
  it("rejects a lesson missing teacher_notes_md, with a precise error", () => {
    const errs: { file: string | null; field: string; message: string }[] = [];
    const warns: { file: string | null; field: string; message: string }[] = [];
    const lesson = parseCourseLesson(
      { id: "x1", order: 1, kind: "lesson", title: "T", source: { printed_pages: [1], pdf_pages: [1] }, source_material: [], exercise_ids: [], test_path: "tests/x1.json" },
      "lessons/x1.json",
      errs,
      warns,
    );
    expect(lesson).toBeNull();
    expect(errs.some((e) => e.field === "teacher_notes_md")).toBe(true);
  });

  it("rejects a lesson with an unknown kind", () => {
    const errs: { file: string | null; field: string; message: string }[] = [];
    const warns: { file: string | null; field: string; message: string }[] = [];
    const lesson = parseCourseLesson(
      { id: "x1", order: 1, kind: "bogus", title: "T", source: { printed_pages: [1], pdf_pages: [1] }, teacher_notes_md: "...", source_material: [{ type: "source_image", path: "a.webp", source: { printed_page: 1, pdf_page: 1, bbox_pt: [0, 0, 1, 1] }, text_status: "unverified_ocr", authoritative_representation: "image" }], exercise_ids: [], test_path: "tests/x1.json" },
      "lessons/x1.json",
      errs,
      warns,
    );
    expect(lesson).toBeNull();
    expect(errs.some((e) => e.field === "kind")).toBe(true);
  });
});

describe("parseCourseTest — per-question skip, never fails the whole test for one bad question", () => {
  it("skips a question with only 3 options and keeps a valid one", () => {
    const errs: { file: string | null; field: string; message: string }[] = [];
    const warns: { file: string | null; field: string; message: string }[] = [];
    const test = parseCourseTest(
      {
        id: "t1",
        lesson_id: "x1",
        title: "T",
        automatic_max_points: 1,
        source_exercise_ids: [],
        automatic_questions: [
          { id: "bad", type: "single_choice", prompt_md: "p", options: [{ id: "A", text_md: "a" }], correct_option_id: "A", explanation_md: "e", max_points: 1 },
          {
            id: "good",
            type: "single_choice",
            prompt_md: "p2",
            options: [{ id: "A", text_md: "a" }, { id: "B", text_md: "b" }, { id: "C", text_md: "c" }, { id: "D", text_md: "d" }],
            correct_option_id: "B",
            explanation_md: "e2",
            max_points: 1,
          },
        ],
      },
      "tests/t1.json",
      errs,
      warns,
    );
    expect(test).not.toBeNull();
    expect(test?.automaticQuestions).toHaveLength(1);
    expect(test?.automaticQuestions[0]?.id).toBe("good");
    expect(warns.some((w) => w.field.includes("[0]"))).toBe(true);
  });
});

describe("parseCourseExercise — required-field rejection", () => {
  it("rejects an exercise with empty content", () => {
    const errs: { file: string | null; field: string; message: string }[] = [];
    const warns: { file: string | null; field: string; message: string }[] = [];
    const exercise = parseCourseExercise(
      { id: "e1", lesson_id: "x1", origin: "textbook", original_number: "1", source: { printed_pages: [1], pdf_pages: [1] }, content: [], figure_ids: [], grading: { mode: "manual_or_tutor_review", answer_key: null } },
      "exercises.jsonl:1",
      errs,
      warns,
    );
    expect(exercise).toBeNull();
    expect(errs.some((e) => e.field === "content")).toBe(true);
  });
});
