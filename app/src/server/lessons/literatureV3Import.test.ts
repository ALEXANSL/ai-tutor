import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  combineLiteratureV3Package,
  parseLiteratureV3Assets,
  parseLiteratureV3Course,
  parseLiteratureV3PackageManifest,
  parseLiteratureV3Pages,
  parseLiteratureV3Readings,
  parseLiteratureV3TaskTables,
  parseLiteratureV3Teacher,
} from "./literatureV3Import";

/**
 * S45 ($0 "Українська література, 6 клас" v2.0.0 chapter-package importer) —
 * tests run against a REAL, trimmed subset of the PO's actual package
 * (Калинич/Дячок, 2023) — `__fixtures__/literature-course-v3/` (2 of 46
 * lessons: L001 — screen+reading+quiz only — and L004 — adds a biography
 * step — chosen so the subset covers all four `flow[].kind` values), never
 * invented data, same convention as `mathCourseV2Import.test.ts`/
 * `literatureV2Import.test.ts`.
 */

const FIXTURES = join(__dirname, "__fixtures__", "literature-course-v3");
function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, path), "utf8"));
}

function parseAll() {
  const manifest = parseLiteratureV3PackageManifest(readJson("package.json"));
  const course = parseLiteratureV3Course(readJson("public/course.json"));
  const readings = parseLiteratureV3Readings(readJson("public/readings.json"));
  const teacher = parseLiteratureV3Teacher(readJson("private/teacher.json"));
  const assets = parseLiteratureV3Assets(readJson("catalog/assets.json"));
  const pages = parseLiteratureV3Pages(readJson("catalog/pages.json"));
  const taskTables = parseLiteratureV3TaskTables(readJson("catalog/task_tables.json"));
  return { manifest, course, readings, teacher, assets, pages, taskTables };
}

describe("literatureV3Import (real fixture subset)", () => {
  it("parses package.json with no errors", () => {
    const { manifest, errors } = parseLiteratureV3PackageManifest(readJson("package.json"));
    expect(errors).toEqual([]);
    expect(manifest?.format).toBe("ukrlit-tutor-package");
    expect(manifest?.book_id).toBe("ukrlit6-kalynych-diachok-2023");
    expect(manifest?.progress_namespace).toBe("ukrlit6-kalynych-diachok-2023@2.0.0");
  });

  // Real bug Alex hit 2026-10-16, TWICE: first with "Українська мова, 6
  // клас" (ukrmova6-semenog-2023, format "ukrmova-tutor-package"), then
  // again minutes later with "Історія" (istoriya6-shchupak-2023, format
  // "history-tutor-package") — each a genuine chapter-package-contract
  // subject (same flow/readings/assets/pages shape, only additive enum
  // values over 2.0.0), rejected only because `zPackageManifest.format`
  // allowlisted exact literals one at a time. Now validates the NAMING
  // PATTERN instead, so a fourth/fifth/etc. subject's own manifest format
  // never needs another hotfix for this.
  it.each(["ukrlit-tutor-package", "ukrmova-tutor-package", "history-tutor-package", "geography-tutor-package"])(
    "accepts any manifest format following the <subject>-tutor-package naming pattern (%s)",
    (format) => {
      const { manifest, errors } = parseLiteratureV3PackageManifest({
        format,
        schema_version: "2.1.0",
        book_id: "some-book-2023",
        progress_namespace: "some-book-2023@2.1.0",
      });
      expect(errors).toEqual([]);
      expect(manifest?.format).toBe(format);
    },
  );

  it("rejects an unrecognized manifest format", () => {
    const { manifest, errors } = parseLiteratureV3PackageManifest({
      format: "some-other-package",
      schema_version: "1.0.0",
      book_id: "x",
      progress_namespace: "x@1.0.0",
    });
    expect(manifest).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("parses the trimmed public course.json with no errors, keeping flow[] order verbatim", () => {
    const result = parseLiteratureV3Course(readJson("public/course.json"));
    expect(result.errors).toEqual([]);
    expect(result.bookId).toBe("ukrlit6-kalynych-diachok-2023");
    expect(result.lessons.map((l) => l.id).sort()).toEqual(["ukrlit6-kalynych-diachok-2023-L001", "ukrlit6-kalynych-diachok-2023-L004"]);

    const l001 = result.lessons.find((l) => l.id === "ukrlit6-kalynych-diachok-2023-L001")!;
    expect(l001.flow.map((f) => f.kind)).toEqual(["screen", "screen", "reading", "reading", "reading", "reading", "screen", "screen", "screen", "screen", "screen", "quiz", "quiz", "screen"]);
    expect(l001.flow[0]).toEqual({ kind: "screen", ref_id: "ukrlit6-kalynych-diachok-2023-L001-screen-01" });

    const l004 = result.lessons.find((l) => l.id === "ukrlit6-kalynych-diachok-2023-L004")!;
    expect(l004.flow.some((f) => f.kind === "biography")).toBe(true);
    expect(l004.biography_ids).toEqual(["ukrlit6-kalynych-diachok-2023-BIO-004"]);

    // Every task in this package is single_choice with a real option set.
    expect(result.tasks.every((t) => t.response_type === "single_choice" && t.options.length >= 2)).toBe(true);
  });

  it("NEVER exposes a correct_option_id anywhere in the public course parse", () => {
    const result = parseLiteratureV3Course(readJson("public/course.json"));
    const serialized = JSON.stringify(result.tasks);
    expect(serialized).not.toContain("correct_option_id");
    expect(serialized).not.toContain("is_correct");
  });

  it("parses public/readings.json (works/items/biographies) with no errors", () => {
    const result = parseLiteratureV3Readings(readJson("public/readings.json"));
    expect(result.errors).toEqual([]);
    expect(result.works.length).toBeGreaterThan(0);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.biographies.length).toBe(1);
    expect(result.biographies[0]!.author_name).toBe("Дара Корній");
    // The actual textbook text is present (not a placeholder/summary).
    expect(result.items[0]!.content.display.length).toBeGreaterThan(0);
    expect(result.items[0]!.content.tts.text).toBe(result.items[0]!.content.display);
  });

  it("parses private/teacher.json (quiz keys + lesson guides) with no errors", () => {
    const result = parseLiteratureV3Teacher(readJson("private/teacher.json"));
    expect(result.errors).toEqual([]);
    expect(result.taskKeys.length).toBe(4);
    expect(result.taskKeys.every((k) => k.correct_option_ids.length >= 1)).toBe(true);
    expect(result.lessonGuides.length).toBe(2);
  });

  it("parses catalog/assets.json as an OBJECT {items} (not a bare array like literature_v2)", () => {
    const result = parseLiteratureV3Assets(readJson("catalog/assets.json"));
    expect(result.errors).toEqual([]);
    const kinds = result.assets.map((a) => a.kind).sort();
    expect(kinds).toContain("textbook_illustration");
    expect(kinds).toContain("lesson_pdf");
    const pdf = result.assets.find((a) => a.kind === "lesson_pdf")!;
    expect(pdf.page_map.length).toBeGreaterThan(0);
    for (const pm of pdf.page_map) {
      expect(pm.printed_page).toBeGreaterThanOrEqual(1);
      expect(pm.source_pdf_page).toBeGreaterThanOrEqual(1);
      expect(pm.bundle_pdf_page).toBeGreaterThanOrEqual(1);
    }
  });

  it("rejects a bare-array catalog/assets.json as the wrong (v2) contract", () => {
    const result = parseLiteratureV3Assets([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.message).toContain("v3");
  });

  it("parses catalog/pages.json as an OBJECT {items} with a reverse lesson/asset index", () => {
    const result = parseLiteratureV3Pages(readJson("catalog/pages.json"));
    expect(result.errors).toEqual([]);
    expect(result.pages.length).toBeGreaterThan(0);
    const withLocation = result.pages.find((p) => p.lesson_locations.length > 0);
    expect(withLocation).toBeDefined();
    expect(withLocation!.lesson_locations[0]!.bundle_pdf_page).toBeGreaterThanOrEqual(1);
  });

  it("validates catalog/task_tables.json, ignores non-empty items with a warning (never fatal)", () => {
    const empty = parseLiteratureV3TaskTables(readJson("catalog/task_tables.json"));
    expect(empty.errors).toEqual([]);
    expect(empty.warnings).toEqual([]);

    const nonEmpty = parseLiteratureV3TaskTables({ schema_version: "2.0.0", book_id: "x", items: [{ foo: "bar" }] });
    expect(nonEmpty.errors).toEqual([]);
    expect(nonEmpty.warnings.length).toBe(1);
  });

  it("combineLiteratureV3Package cross-checks referential integrity with no warnings on this consistent subset", () => {
    const { manifest, course, readings, teacher, assets, pages, taskTables } = parseAll();
    const combined = combineLiteratureV3Package(manifest, course, readings, teacher, assets, pages, taskTables);
    expect(combined.errors).toEqual([]);
    expect(combined.warnings).toEqual([]);
    expect(combined.taskKeys).toHaveLength(4);
    expect(combined.lessons).toHaveLength(2);
  });

  it("drops a flow[] step whose ref_id doesn't exist in this subset, with a warning instead of a thrown error", () => {
    const { manifest, course, readings, teacher, assets, pages, taskTables } = parseAll();
    const mutatedCourse = { ...course, lessons: course.lessons.map((l, i) => (i === 0 ? { ...l, flow: [...l.flow, { kind: "reading" as const, ref_id: "no-such-reading" }] } : l)) };
    const combined = combineLiteratureV3Package(manifest, mutatedCourse, readings, teacher, assets, pages, taskTables);
    expect(combined.warnings.some((w) => w.message.includes("no-such-reading"))).toBe(true);
  });

  it("drops a quiz key whose correct_option_ids references a non-existent option, with a warning", () => {
    const { manifest, course, readings, teacher, assets, pages, taskTables } = parseAll();
    const mutatedTeacher = { ...teacher, taskKeys: teacher.taskKeys.map((k, i) => (i === 0 ? { ...k, correct_option_ids: ["no-such-option"] } : k)) };
    const combined = combineLiteratureV3Package(manifest, course, readings, mutatedTeacher, assets, pages, taskTables);
    expect(combined.taskKeys).toHaveLength(3);
    expect(combined.warnings.some((w) => w.message.includes("no-such-option"))).toBe(true);
  });
});
