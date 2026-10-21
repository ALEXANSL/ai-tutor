import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forFamily } from "@/server/db/family-scope";
import { parseLiteratureV3Assets, parseLiteratureV3PackageManifest, type ParsedAsset, type ParsedLiteratureV3Package } from "./literatureV3Import";
import { persistLiteratureV3Package } from "./literatureV3Persist";

const FAMILY = "family-one";
const PACKAGE = "package-one";
const FIXTURE = join(__dirname, "__fixtures__/literature-course-v3");
const assets = parseLiteratureV3Assets(JSON.parse(readFileSync(join(FIXTURE, "catalog/assets.json"), "utf8"))).assets;
const manifest = parseLiteratureV3PackageManifest(JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8"))).manifest;
interface StoredAsset extends Record<string, unknown> {
  owner_family_id: string; package_id: string; asset_key: string; storage_path: string | null;
}
const stored: StoredAsset[] = [];
const writes: { table: string; row: Record<string, unknown> }[] = [];
const reads: { table: string; filters: [string, unknown][] }[] = [];
const blobs = new Map<string, Uint8Array>();
let uploadError: { message: string } | null = null;
let readError: { message: string } | null = null;
const upload = vi.fn(async (path: string, bytes: Uint8Array) => {
  if (!uploadError) blobs.set(path, bytes);
  return { error: uploadError };
});
function existing(asset: ParsedAsset, extra: Record<string, unknown> = {}): StoredAsset {
  return {
    owner_family_id: FAMILY, package_id: PACKAGE, asset_key: asset.id,
    storage_path: `lit-v3/${PACKAGE}/${asset.id}`, kind: asset.kind,
    mime_type: asset.mime_type, byte_size: asset.byte_size, sha256: asset.sha256,
    title: asset.title, caption: asset.caption, alt: asset.alt, tts: asset.tts ?? {}, page_map: asset.page_map,
    ...extra,
  };
}
function parsed(items: ParsedAsset[]): ParsedLiteratureV3Package {
  return { manifest, assets: items, lessons: [], tasks: [], works: [], readingItems: [], biographies: [], taskKeys: [], lessonGuides: [], pages: [], errors: [], warnings: [] };
}
function read(table: string) {
  const log = { table, filters: [] as [string, unknown][] }; reads.push(log);
  const self = {
    eq: (field: string, value: unknown) => { log.filters.push([field, value]); return self; },
    in: (field: string, values: unknown[]) => { log.filters.push([field, values]); return self; },
    returns: () => Promise.resolve({
      data: stored.filter((row) => log.filters.every(([field, value]) => Array.isArray(value) ? value.includes(row[field]) : value === row[field])),
      error: readError,
    }),
  };
  return self;
}
const client = {
  from: (table: string) => ({
    select: () => read(table),
    upsert: (row: Record<string, unknown>) => {
      writes.push({ table, row });
      if (table === "literature_v3_assets") {
        const index = stored.findIndex((old) => old.package_id === row.package_id && old.asset_key === row.asset_key);
        if (index >= 0) stored[index] = row as StoredAsset; else stored.push(row as StoredAsset);
      }
      const promise = Promise.resolve({ data: table === "literature_v3_packages" ? { id: PACKAGE } : null, error: null });
      return { then: promise.then.bind(promise), select: () => ({ single: () => promise }) };
    },
  }),
  storage: { from: () => ({ upload }) },
} as unknown as SupabaseClient;
const scope = forFamily(FAMILY, client);
const persist = (items: ParsedAsset[], files = new Map<string, Uint8Array>()) => persistLiteratureV3Package(scope, { subjectId: "geography" }, parsed(items), files);
const assetRow = (id: string) => writes.find((write) => write.table === "literature_v3_assets" && write.row.asset_key === id)!.row;
beforeEach(() => {
  stored.length = 0; writes.length = 0; reads.length = 0; blobs.clear();
  upload.mockClear(); uploadError = null; readError = null;
});

describe("literature-v3 media persistence during re-import", () => {
  it.each(["textbook_illustration", "lesson_pdf"] as const)("keeps an existing %s file when JSON is re-imported without its binary", async (kind) => {
    const asset = assets.find((item) => item.kind === kind)!;
    const old = existing(asset); stored.push(old);
    blobs.set(old.storage_path!, new Uint8Array([1, 2]));
    const result = await persist([asset]);
    expect(assetRow(asset.id).storage_path).toBe(old.storage_path);
    expect(assetRow(asset.id)).toMatchObject({ mime_type: old.mime_type, sha256: old.sha256, byte_size: old.byte_size });
    expect(result.assetsMissing).toEqual([]); expect(result.assetUploadFailures).toEqual([]);
    expect(result.assetsUploaded).toBe(0); expect(upload).not.toHaveBeenCalled();
    expect(blobs.get(old.storage_path!)).toEqual(new Uint8Array([1, 2]));
  });

  it("preserves an old file and reports a failed replacement instead of nulling the row", async () => {
    const asset = assets[0]!; const old = existing(asset); stored.push(old);
    blobs.set(old.storage_path!, new Uint8Array([1, 2])); uploadError = { message: "storage quota exceeded" };
    const result = await persist([asset], new Map([[asset.path, new Uint8Array([9, 8, 7])]]));
    expect(assetRow(asset.id).storage_path).toBe(old.storage_path);
    expect(result.assetsMissing).toEqual([]);
    expect(result.assetUploadFailures).toEqual([{ path: asset.path, message: "storage quota exceeded" }]);
    expect(result.assetsUploaded).toBe(0);
    expect(upload.mock.calls[0]![0]).not.toBe(old.storage_path);
    expect(blobs.get(old.storage_path!)).toEqual(new Uint8Array([1, 2]));
  });

  it("updates the pointer only after a successful upload to an immutable content-hash path", async () => {
    const asset = assets[0]!; const old = existing(asset); stored.push(old);
    const oldBytes = new Uint8Array([1, 2]); const replacement = new Uint8Array([9, 8, 7]);
    blobs.set(old.storage_path!, oldBytes);
    const result = await persist([asset], new Map([[asset.path, replacement]]));
    const hash = createHash("sha256").update(replacement).digest("hex");
    const expected = `lit-v3/${PACKAGE}/${encodeURIComponent(asset.id)}/${hash}`;
    expect(assetRow(asset.id).storage_path).toBe(expected);
    expect(blobs.get(expected)).toEqual(replacement); expect(blobs.get(old.storage_path!)).toEqual(oldBytes);
    expect(result.assetsUploaded).toBe(1); expect(result.assetsMissing).toEqual([]); expect(result.assetUploadFailures).toEqual([]);
  });

  it("records the uploaded bytes' actual size and hash instead of a wrong catalogue descriptor", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const asset = { ...assets[0]!, byte_size: 999_999, sha256: "f".repeat(64) };
    await persist([asset], new Map([[asset.path, bytes]]));
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    expect(assetRow(asset.id)).toMatchObject({ byte_size: bytes.byteLength, sha256: actualHash });
    expect(String(assetRow(asset.id).storage_path)).toContain(actualHash);
  });

  it("records a new missing binary as unresolved instead of inventing a file pointer", async () => {
    const asset = assets[0]!;
    const result = await persist([asset]);
    expect(assetRow(asset.id).storage_path).toBeNull();
    expect(result.assetsMissing).toEqual([asset.path]); expect(result.assetReuseWarnings).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("reports both an upload failure and missing media when there is no previous file to retain", async () => {
    const asset = assets[0]!; uploadError = { message: "unsupported file" };
    const result = await persist([asset], new Map([[asset.path, new Uint8Array([9])]]));
    expect(assetRow(asset.id).storage_path).toBeNull(); expect(result.assetsMissing).toEqual([asset.path]);
    expect(result.assetUploadFailures).toEqual([{ path: asset.path, message: "unsupported file" }]);
  });

  it.each(["family", "package"])("never borrows a previous path from another %s even if the asset key matches", async (boundary) => {
    const asset = assets[0]!;
    stored.push(existing(asset, boundary === "family" ? { owner_family_id: "other-family", storage_path: "private-other-family" } : { package_id: "other-package", storage_path: "private-other-package" }));
    const result = await persist([asset]);
    expect(assetRow(asset.id).storage_path).toBeNull(); expect(result.assetsMissing).toEqual([asset.path]);
    expect(reads[0]!.filters).toEqual(expect.arrayContaining([["owner_family_id", FAMILY], ["package_id", PACKAGE], ["asset_key", [asset.id]]]));
  });

  it("warns about changed source metadata and retains the previous PDF hash, type, map and labels", async () => {
    const original = assets.find((asset) => asset.kind === "lesson_pdf")!;
    const old = existing(original, { title: "Попередня книга", page_map: [{ page_id: "old-page", printed_page: 1, source_pdf_page: 1, bundle_pdf_page: 1 }] });
    stored.push(old);
    const changed = { ...original, title: "Нова книга", sha256: "f".repeat(64), byte_size: original.byte_size + 1, page_map: [] };
    const result = await persist([changed]);
    expect(assetRow(original.id)).toMatchObject({ storage_path: old.storage_path, sha256: old.sha256, byte_size: old.byte_size, mime_type: old.mime_type, title: old.title, page_map: old.page_map });
    expect(result.assetReuseWarnings).toEqual([{ path: changed.path, message: expect.stringContaining("Залишено попередній файл") }]);
    expect(result.assetsMissing).toEqual([]);
  });

  it("updates descriptive metadata when the retained media still matches the source descriptor", async () => {
    const asset = assets[0]!; stored.push(existing(asset));
    await persist([{ ...asset, caption: "Виправлений підпис" }]);
    expect(assetRow(asset.id)).toMatchObject({ storage_path: existing(asset).storage_path, caption: "Виправлений підпис", sha256: asset.sha256 });
  });

  it("keeps the uploaded PDF map when a metadata-only package omits hash and size", async () => {
    const original = assets.find(asset => asset.kind === "lesson_pdf")!;
    const old = existing(original);
    stored.push(old);
    const result = await persist([{ ...original, sha256: "", byte_size: 0, page_map: [] }]);
    expect(assetRow(original.id).page_map).toEqual(old.page_map);
    expect(result.assetReuseWarnings).toHaveLength(1);
  });

  it("stops safely when existing asset metadata cannot be read rather than clearing unknown paths", async () => {
    const asset = assets[0]!; stored.push(existing(asset)); readError = { message: "database unavailable" };
    await expect(persist([asset])).rejects.toThrow("reading existing literature_v3_assets failed");
    expect(writes.filter((write) => write.table === "literature_v3_assets")).toEqual([]); expect(upload).not.toHaveBeenCalled();
  });
});
