import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseUnifiedCourseArchive } from "./unifiedCourseArchive";
import { readSafeCourseZip } from "./safeCourseZip";
const prompt = readFileSync(join(process.cwd(), "public/content-package-prompt.md"), "utf8");
function example() {
  const files: Record<string, Uint8Array> = {};
  for (const path of ["package.json", "public/course.json", "public/readings.json", "private/teacher.json"]) {
    const match = /```json\s*([\s\S]*?)```/.exec(prompt.slice(prompt.indexOf(`### ${path}`)));
    files[path] = strToU8(match![1]!);
  }
  return files;
}
function fixture(name: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  function visit(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); const key = prefix + entry.name;
      if (entry.isDirectory()) visit(path, key + "/"); else files[key] = readFileSync(path);
    }
  }
  visit(join(__dirname, "__fixtures__", name)); return zipSync(files);
}
describe("single ZIP course detection", () => {
  it.each([["math-course-v2", "math_v2"], ["literature-course-v2", "literature_v2"], ["literature-course-v3", "chapter_v3"], ["ister-math6-part1", "course_v1"], ["zarlit-6", "markdown_v1"]])("recognizes existing %s packages", (name, format) => {
    const parsed = parseUnifiedCourseArchive(fixture(name!));
    expect(parsed.format).toBe(format); if (format !== "course_v1") expect(parsed.errors).toEqual([]); else expect(parsed.errors.length).toBeGreaterThan(0); expect(parsed.counts.lessons).toBeGreaterThan(0);
  });
  it.each(["", "prepared-course/"])("accepts text-only universal course under %s", root => {
    const files = Object.fromEntries(Object.entries(example()).map(([path, value]) => [root + path, value]));
    const parsed = parseUnifiedCourseArchive(zipSync(files));
    expect(parsed.format).toBe("chapter_v3"); expect(parsed.errors).toEqual([]);
    expect(parsed.counts.lessons).toBe(1); expect(parsed.counts.images).toBe(0); expect(parsed.counts.pdfs).toBe(0);
  });
  it("accepts the existing flat JSON layout", () => {
    const files = Object.fromEntries(Object.entries(example()).map(([path, value]) => [path.split("/").at(-1)!, value]));
    expect(parseUnifiedCourseArchive(zipSync(files)).errors).toEqual([]);
  });
  it("rejects ambiguous courses and unknown versions rather than falling back", () => {
    const files = example();
    expect(() => parseUnifiedCourseArchive(zipSync({ ...files, ...Object.fromEntries(Object.entries(files).map(([path, value]) => [`other/${path}`, value])) }))).toThrow(/кілька/);
    const manifest = JSON.parse(new TextDecoder().decode(files["package.json"])); manifest.schema_version = "99";
    files["package.json"] = strToU8(JSON.stringify(manifest));
    expect(() => parseUnifiedCourseArchive(zipSync(files))).toThrow(/версія/);
  });
  it("rejects malformed mandatory teacher JSON", () => {
    const files = example(); files["private/teacher.json"] = strToU8("{");
    expect(() => parseUnifiedCourseArchive(zipSync(files))).toThrow(/teacher.json/);
  });
});
describe("bounded ZIP decoding", () => {
  it("reads normal entries and normalizes backslashes", () => {
    expect(Array.from(readSafeCourseZip(zipSync({ "assets\\picture.txt": strToU8("ok") }))["assets/picture.txt"]!)).toEqual(Array.from(strToU8("ok")));
  });
  it.each(["../escape.json", "/absolute.json", "C:\\escape.json", "nested/../../escape.json"])("rejects unsafe path %s", path => {
    expect(() => readSafeCourseZip(zipSync({ [path]: strToU8("{}") }))).toThrow();
  });
  it("rejects duplicate normalized paths", () => {
    expect(() => readSafeCourseZip(zipSync({ "a/b.json": strToU8("{}"), "a\\b.json": strToU8("{}") }))).toThrow();
  });
  it("enforces entry, JSON, expanded, count, compressed and ratio limits before extraction", () => {
    const bytes = zipSync({ "course.json": strToU8("x".repeat(1000)), "other.txt": strToU8("a") });
    for (const limits of [{ entryBytes: 100 }, { jsonBytes: 100 }, { expandedBytes: 100 }, { entries: 1 }, { compressedBytes: 10 }, { ratio: 1 }]) expect(() => readSafeCourseZip(bytes, limits)).toThrow();
  });
  it("rejects corrupt stored bytes using CRC", () => {
    const bytes = zipSync({ "file.txt": strToU8("hello") }, { level: 0 });
    bytes[30 + "file.txt".length] = bytes[30 + "file.txt".length]! ^ 1;
    expect(() => readSafeCourseZip(bytes)).toThrow();
  });
  it("rejects truncated archives", () => {
    const bytes = zipSync({ "file": strToU8("hello") });
    expect(() => readSafeCourseZip(bytes.slice(0, -3))).toThrow();
  });
});


describe("printed source page compatibility", () => {
  function archive(sourcePages: unknown[], pages: { id: string; printed_page: number; source_pdf_page: number }[]) {
    const files = example();
    const course = JSON.parse(new TextDecoder().decode(files["public/course.json"]));
    course.lessons[0].source_pages = sourcePages;
    files["public/course.json"] = strToU8(JSON.stringify(course));
    files["catalog/pages.json"] = strToU8(JSON.stringify({ book_id: course.book_id, items: pages }));
    return parseUnifiedCourseArchive(zipSync(files));
  }
  it("maps only numeric source_pages through actual printed numbers, preserving existing IDs, repeats and numeric grade", () => {
    const parsed = archive([4, "book-P006", 4], [{ id: "book-P004", printed_page: 4, source_pdf_page: 7 }, { id: "book-P006", printed_page: 6, source_pdf_page: 9 }]);
    expect(parsed.errors).toEqual([]);
    if (parsed.format !== "chapter_v3") throw new Error("chapter expected");
    expect(parsed.parsed.lessons[0]!.source_pages).toEqual(["book-P004", "book-P006", "book-P004"]);
    expect(parsed.parsed.lessons[0]!.grade).toBe(6);
    expect(parsed.warnings).toContainEqual(expect.objectContaining({ field: "lessons.source_pages", message: expect.stringContaining("2") }));
  });
  it.each([0, -1, 4.5, 999, Number.MAX_SAFE_INTEGER + 1])("rejects unresolved or invalid printed number %s without inventing an ID", value => {
    const parsed = archive([value], [{ id: "book-P004", printed_page: 4, source_pdf_page: 7 }]);
    expect(parsed.errors).toContainEqual(expect.objectContaining({ field: "lessons[0].source_pages[0]" }));
  });
  it("requires an explicit ID when multiple catalog pages have the same printed number", () => {
    const parsed = archive([4], [{ id: "part1-P004", printed_page: 4, source_pdf_page: 7 }, { id: "part2-P004", printed_page: 4, source_pdf_page: 70 }]);
    expect(parsed.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("кільком") }));
  });
});
