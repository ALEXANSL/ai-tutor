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
