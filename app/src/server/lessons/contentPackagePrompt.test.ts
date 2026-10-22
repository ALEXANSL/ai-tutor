import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
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

const prompt = readFileSync(join(process.cwd(), "public/content-package-prompt.md"), "utf8");

function jsonAfter(marker: string): unknown {
  const index = prompt.indexOf(marker);
  if (index < 0) throw new Error(`Missing prompt section ${marker}`);
  const block = /```json\s*([\s\S]*?)```/.exec(prompt.slice(index));
  if (!block) throw new Error(`Missing JSON in ${marker}`);
  return JSON.parse(block[1]!);
}

function exampleFiles(): Record<string, unknown> {
  const emptyCatalog = jsonAfter("## 4. Ілюстрації та PDF");
  return {
    "package.json": jsonAfter("### package.json"),
    "public/course.json": jsonAfter("### public/course.json"),
    "public/readings.json": jsonAfter("### public/readings.json"),
    "private/teacher.json": jsonAfter("### private/teacher.json"),
    "catalog/assets.json": emptyCatalog,
    "catalog/pages.json": emptyCatalog,
    "catalog/task_tables.json": emptyCatalog,
  };
}

describe("published universal course prompt examples", () => {
  it("contains syntactically valid copyable JSON blocks", () => {
    const blocks = [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    for (const block of blocks) expect(() => JSON.parse(block[1]!)).not.toThrow();
  });

  it("produces a seven-document text-only ZIP accepted by the actual chapter parsers", () => {
    const entries = Object.fromEntries(Object.entries(exampleFiles()).map(([path, value]) => [path, strToU8(JSON.stringify(value))]));
    const archive = unzipSync(zipSync(entries));
    expect(Object.keys(archive).sort()).toEqual(Object.keys(entries).sort());
    expect(Object.keys(archive).some(path => path.startsWith("assets/") || path.startsWith("lessons/"))).toBe(false);
    const get = (path: string): unknown => JSON.parse(strFromU8(archive[path]!));
    const result = combineLiteratureV3Package(
      parseLiteratureV3PackageManifest(get("package.json")),
      parseLiteratureV3Course(get("public/course.json")),
      parseLiteratureV3Readings(get("public/readings.json")),
      parseLiteratureV3Teacher(get("private/teacher.json")),
      parseLiteratureV3Assets(get("catalog/assets.json")),
      parseLiteratureV3Pages(get("catalog/pages.json")),
      parseLiteratureV3TaskTables(get("catalog/task_tables.json")),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.manifest?.format).toBe("subject-tutor-package");
    expect(result.lessons).toHaveLength(1);
    expect(result.taskKeys).toHaveLength(result.tasks.length);
    expect(result.assets).toEqual([]);
    expect(result.pages).toEqual([]);
  });
});
