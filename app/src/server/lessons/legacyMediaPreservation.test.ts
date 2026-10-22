import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forFamily } from "@/server/db/family-scope";
import { parseMathCourseV2Public, type ParsedMathCourseV2Package } from "./mathCourseV2Import";
import { parseLiteratureV2Assets, type ParsedLiteratureV2Package } from "./literatureV2Import";
import { persistMathCourseV2Package } from "./mathCourseV2Persist";
import { persistLiteratureV2Package } from "./literatureV2Persist";

const FAMILY = "family", PACKAGE = "package";
const readJson = (path: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", path), "utf8"));
const mathPublic = parseMathCourseV2Public(readJson("math-course-v2/public/course.json")).data;
const mathAsset = mathPublic.assets[0]!;
const litAsset = parseLiteratureV2Assets(readJson("literature-course-v2/catalog/assets.json")).assets[0]!;
const stored = new Map<string, Record<string, unknown>[]>();
const reads: { table: string; filters: [string, unknown][] }[] = [];
const writes: { table: string; row: Record<string, unknown> }[] = [];
const blobs = new Map<string, Uint8Array>();
let uploadFailure = false, readFailure = false, rowFailure = false;
const upload = vi.fn(async (path: string, bytes: Uint8Array) => {
  if (uploadFailure) return { error: { message: "storage quota exceeded" } };
  blobs.set(path, bytes);
  return { error: null };
});
const client = {
  from: (table: string) => ({
    select: () => {
      const call = { table, filters: [] as [string, unknown][] }; reads.push(call);
      const self = {
        eq: (field: string, value: unknown) => { call.filters.push([field, value]); return self; },
        in: (field: string, values: unknown[]) => { call.filters.push([field, values]); return self; },
        returns: async () => ({ error: readFailure ? { message: "read failed" } : null,
          data: (stored.get(table) ?? []).filter(row => call.filters.every(([field, value]) => Array.isArray(value) ? value.includes(row[field]) : row[field] === value)) }),
      }; return self;
    },
    upsert: (row: Record<string, unknown>) => {
      const failed = rowFailure && /_assets$/.test(table);
      if (!failed) {
        writes.push({ table, row });
        if (/_assets$/.test(table)) {
          const rows = stored.get(table) ?? [];
          const index = rows.findIndex(old => old.owner_family_id === row.owner_family_id && old.package_id === row.package_id && old.asset_key === row.asset_key);
          if (index >= 0) rows[index] = row; else rows.push(row);
          stored.set(table, rows);
        }
      }
      const promise = Promise.resolve({ data: /_packages$/.test(table) ? { id: PACKAGE } : null, error: failed ? { message: "write failed" } : null });
      return { then: promise.then.bind(promise), select: () => ({ single: () => promise }) };
    },
  }),
  storage: { from: () => ({ upload }) },
} as unknown as SupabaseClient;
const scope = forFamily(FAMILY, client);
const configurations = [
  {
    name: "math", table: "course_v2_assets", prefix: "v2", id: mathAsset.id, path: mathAsset.path,
    descriptor: {
      mime_type: mathAsset.mime_type, alt: mathAsset.alt, printed_page: mathAsset.source.printed_page, pdf_page: mathAsset.source.pdf_page,
      width_px: mathAsset.width_px, height_px: mathAsset.height_px, physical_width_mm: mathAsset.physical_width_mm,
      physical_height_mm: mathAsset.physical_height_mm, scale_px_per_pdf_point: mathAsset.scale_pixels_per_pdf_point,
      is_construction_template: /blank/i.test(mathAsset.id),
    },
    run: (files = new Map<string, Uint8Array>(), changed = false) => {
      const parsed: ParsedMathCourseV2Package = { course: mathPublic.course, assets: [{ ...mathAsset, ...(changed ? { width_px: mathAsset.width_px + 5 } : {}) }], lessons: [], screens: [], questions: [], quizzes: [], quizItems: [], exercises: [], questionKeys: [], exerciseSolutions: [], sourceIssues: [], errors: [], warnings: [] };
      return persistMathCourseV2Package(scope, { subjectId: "subject" }, parsed, files);
    },
  },
  {
    name: "literature", table: "literature_v2_assets", prefix: "lit-v2", id: litAsset.id, path: litAsset.path,
    descriptor: {
      page_id: litAsset.page_id, mime_type: litAsset.path.endsWith(".png") ? "image/png" : "image/jpeg",
      caption: litAsset.caption, alt: litAsset.alt, tts: litAsset.tts ?? {}, discussion_prompt: litAsset.discussion_prompt ?? {},
      printed_page: litAsset.source.printed_page, pdf_page: litAsset.source.pdf_page, bbox_pdf_points: litAsset.source.bbox_pdf_points,
      rights: litAsset.rights, sha256: litAsset.sha256,
    },
    run: (files = new Map<string, Uint8Array>(), changed = false) => {
      const parsed: ParsedLiteratureV2Package = { bookId: "book", assets: [{ ...litAsset, ...(changed ? { sha256: "f".repeat(64), caption: "New caption" } : {}) }], lessons: [], tasks: [], taskKeys: [], taskTables: [], errors: [], warnings: [] };
      return persistLiteratureV2Package(scope, { subjectId: "subject" }, parsed, files);
    },
  },
];
beforeEach(() => {
  stored.clear(); reads.length = 0; writes.length = 0; blobs.clear(); upload.mockClear();
  uploadFailure = false; readFailure = false; rowFailure = false;
});
describe.each(configurations)("$name optional media reimport", config => {
  function oldRow(overrides: Record<string, unknown> = {}) {
    return { owner_family_id: FAMILY, package_id: PACKAGE, asset_key: config.id, storage_path: `${config.prefix}/${PACKAGE}/old-file`, ...config.descriptor, ...overrides };
  }
  it("keeps old bytes and metadata without reporting an existing illustration missing", async () => {
    const old = oldRow(); stored.set(config.table, [old]); blobs.set(old.storage_path, new Uint8Array([1, 2]));
    const result = await config.run();
    expect(result.assetsMissing).toEqual([]);
    expect(result.assetsUploaded).toBe(0);
    expect(stored.get(config.table)).toEqual([old]);
    expect(blobs.get(old.storage_path)).toEqual(new Uint8Array([1, 2]));
    expect(writes.some(write => write.table === config.table)).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(result.assetReuseWarnings).toEqual([]);
  });
  it("reports changed descriptors without relabeling a retained file", async () => {
    const old = oldRow(); stored.set(config.table, [old]);
    const result = await config.run(undefined, true);
    expect(stored.get(config.table)).toEqual([old]);
    expect(result.assetReuseWarnings).toHaveLength(1);
    expect(result.assetReuseWarnings?.[0]?.message).toContain("попередній файл");
  });
  it("does not overwrite old media when a new upload fails", async () => {
    const old = oldRow(); stored.set(config.table, [old]); blobs.set(old.storage_path, new Uint8Array([1, 2])); uploadFailure = true;
    const result = await config.run(new Map([[config.path, new Uint8Array([3, 4])]]), true);
    expect(result.assetsMissing).toEqual([]);
    expect(result.assetUploadFailures).toHaveLength(1);
    expect(stored.get(config.table)).toEqual([old]);
    expect(blobs.get(old.storage_path)).toEqual(new Uint8Array([1, 2]));
    expect(upload.mock.calls[0]?.[0]).not.toBe(old.storage_path);
  });
  it("publishes a successful replacement under an immutable content hash", async () => {
    const old = oldRow(); stored.set(config.table, [old]); blobs.set(old.storage_path, new Uint8Array([1, 2]));
    const bytes = new Uint8Array([5, 6, 7]); const digest = createHash("sha256").update(bytes).digest("hex");
    const result = await config.run(new Map([[config.path, bytes]]));
    const path = `${config.prefix}/${PACKAGE}/${encodeURIComponent(config.id)}/${digest}`;
    expect(stored.get(config.table)?.[0]?.storage_path).toBe(path);
    expect(blobs.get(path)).toEqual(bytes);
    expect(blobs.get(old.storage_path)).toEqual(new Uint8Array([1, 2]));
    expect(result.assetsUploaded).toBe(1);
    if (config.name === "literature") expect(stored.get(config.table)?.[0]?.sha256).toBe(digest);
  });
  it("keeps the old pointer when the metadata write fails after uploading new bytes", async () => {
    const old = oldRow(); stored.set(config.table, [old]); blobs.set(old.storage_path, new Uint8Array([1, 2])); rowFailure = true;
    await expect(config.run(new Map([[config.path, new Uint8Array([8, 9])]]))).rejects.toThrow("write failed");
    expect(stored.get(config.table)).toEqual([old]); expect(blobs.get(old.storage_path)).toEqual(new Uint8Array([1, 2]));
  });
  it("does not retain another family's or another package's file", async () => {
    stored.set(config.table, [oldRow({ owner_family_id: "other-family" }), oldRow({ package_id: "other-package" })]);
    const result = await config.run();
    expect(result.assetsMissing).toEqual([config.path]);
    expect(reads[0]?.filters).toContainEqual(["owner_family_id", FAMILY]);
    expect(reads[0]?.filters).toContainEqual(["package_id", PACKAGE]);
  });
  it("fails closed on an existing-media lookup error", async () => {
    stored.set(config.table, [oldRow()]); readFailure = true;
    await expect(config.run()).rejects.toThrow("reading existing");
    expect(upload).not.toHaveBeenCalled();
    expect(writes.some(write => write.table === config.table)).toBe(false);
  });
});
