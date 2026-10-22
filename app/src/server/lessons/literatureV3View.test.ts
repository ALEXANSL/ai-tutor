import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ rows: new Map<string, unknown[]>(), calls: [] as { familyId: string; table: string; filters: [string, unknown][] }[] }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => ({ select: (table: string) => {
  const call = { familyId, table, filters: [] as [string, unknown][] }; mock.calls.push(call);
  const chain = {
    eq: (column: string, value: unknown) => { call.filters.push([column, value]); return chain; },
    order: () => chain,
    returns: async () => ({ data: mock.rows.get(table) ?? [] }),
  };
  return chain;
} }) }));
const { buildLiteratureV3BookIndex, getLiteratureV3BookIndex } = await import("./literatureV3View");
import type { LiteratureV3BookIndexPageRow, LiteratureV3BookIndexAssetRow } from "./literatureV3View";

const key = "geography-6-hilberh-2023-PDF-L001";
const assets: LiteratureV3BookIndexAssetRow[] = [{ id: "uploaded-pdf", asset_key: key, storage_path: "lit-v3/package/pdf-L001", page_map: [
  { printed_page: 5, bundle_pdf_page: 1 }, { printed_page: 6, bundle_pdf_page: 2 },
] }];
const pages: LiteratureV3BookIndexPageRow[] = [
  { printed_page: 1, lesson_locations: [] },
  { printed_page: 5, lesson_locations: [{ lesson_key: "L001", pdf_asset_key: key, bundle_pdf_page: 1 }] },
  { printed_page: 6, lesson_locations: [{ lesson_key: "L001", pdf_asset_key: key, bundle_pdf_page: 2 }] },
];
beforeEach(() => { mock.rows.clear(); mock.calls.length = 0; });

describe("geography virtual textbook index", () => {
  it("opens printed page 5 at bundle page 1 and page 6 at bundle page 2", () => {
    // The actual geography catalog also has source_pdf_page 8 and 9 here.
    // Those refer to the original full book, not to these small lesson PDFs.
    expect(buildLiteratureV3BookIndex(pages, assets)).toEqual([
      { printedPage: 5, assetId: "uploaded-pdf", bundlePdfPage: 1 },
      { printedPage: 6, assetId: "uploaded-pdf", bundlePdfPage: 2 },
    ]);
  });
  it("uses the retained PDF's saved page map instead of newer reverse-index offsets", () => {
    const changedReverseIndex = [{ printed_page: 5, lesson_locations: [
      { lesson_key: "L001", pdf_asset_key: key, bundle_pdf_page: 2 },
    ] }];
    expect(buildLiteratureV3BookIndex(changedReverseIndex, assets)).toEqual([
      { printedPage: 5, assetId: "uploaded-pdf", bundlePdfPage: 1 },
    ]);
  });
  it("does not add a page to a retained mapped PDF when only the newer reverse index mentions it", () => {
    const newPage = [{ printed_page: 7, lesson_locations: [
      { lesson_key: "L001", pdf_asset_key: key, bundle_pdf_page: 3 },
    ] }];
    expect(buildLiteratureV3BookIndex(newPage, assets)).toEqual([]);
    // Legacy files with no per-PDF map can still use their explicit reverse location.
    expect(buildLiteratureV3BookIndex(newPage, [{ ...assets[0]!, page_map: [] }])).toEqual([
      { printedPage: 7, assetId: "uploaded-pdf", bundlePdfPage: 3 },
    ]);
  });
  it("does not advertise PDFs that were catalogued but never uploaded", () => {
    expect(buildLiteratureV3BookIndex(pages, assets.map((asset) => ({ ...asset, storage_path: null })))).toEqual([]);
    expect(buildLiteratureV3BookIndex(pages, [])).toEqual([]);
  });
  it("uses another available lesson PDF when the first page location is unavailable", () => {
    const alternatives = [{ printed_page: 5, lesson_locations: [
      { lesson_key: "missing", pdf_asset_key: "not-uploaded", bundle_pdf_page: 9 },
      { lesson_key: "L001", pdf_asset_key: key, bundle_pdf_page: 1 },
    ] }];
    expect(buildLiteratureV3BookIndex(alternatives, assets)).toEqual([{ printedPage: 5, assetId: "uploaded-pdf", bundlePdfPage: 1 }]);
  });
  it("can recover a missing reverse location only from the PDF's explicit page map", () => {
    expect(buildLiteratureV3BookIndex([{ printed_page: 5, lesson_locations: [] }], assets)).toEqual([{ printedPage: 5, assetId: "uploaded-pdf", bundlePdfPage: 1 }]);
    expect(buildLiteratureV3BookIndex([{ printed_page: 4, lesson_locations: [] }], assets)).toEqual([]);
  });
  it("rejects invalid bundle pages and keeps pages sorted without duplicates", () => {
    const duplicate = { printed_page: 5, lesson_locations: [{ lesson_key: "L001", pdf_asset_key: key, bundle_pdf_page: 0 }] };
    expect(buildLiteratureV3BookIndex([pages[2]!, duplicate, pages[1]!], [{ ...assets[0]!, page_map: [] }])).toEqual([
      { printedPage: 5, assetId: "uploaded-pdf", bundlePdfPage: 1 }, { printedPage: 6, assetId: "uploaded-pdf", bundlePdfPage: 2 },
    ]);
  });
  it("loads pages and PDF assets only from the requested family and package", async () => {
    mock.rows.set("literature_v3_pages", pages); mock.rows.set("literature_v3_assets", assets);
    expect(await getLiteratureV3BookIndex("family", "package")).toHaveLength(2);
    expect(mock.calls).toEqual([
      { familyId: "family", table: "literature_v3_pages", filters: [["package_id", "package"]] },
      { familyId: "family", table: "literature_v3_assets", filters: [["package_id", "package"], ["kind", "lesson_pdf"]] },
    ]);
  });
});
