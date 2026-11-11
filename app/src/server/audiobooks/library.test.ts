import { beforeEach, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { bookFixture, requestFixture, materialId, familyId } from "./__fixtures__/part";
const f = vi.hoisted(() => ({ meta: vi.fn(), settings: vi.fn(), download: vi.fn(), scope: vi.fn() }));
vi.mock("@/server/books/reader", () => ({ getBookMaterialMeta: f.meta }));
vi.mock("@/server/drive/google", () => ({ isValidDriveId: () => true, downloadFile: f.download }));
vi.mock("@/server/drive/service", () => ({ getDriveToken: async () => async () => "test" }));
vi.mock("./store", () => ({ readLibrarySettings: f.settings, SETTINGS_TYPE: "audiobook.book", documentId: (v: string) => v, defaultLibrarySettings: { author: "", printedOffset: 0, printedConfirmed: false, chapters: [] } }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: f.scope }));
import { physicalRange, originalBookText, loadAudioSource } from "./library";
beforeEach(() => { vi.clearAllMocks(); f.meta.mockResolvedValue({ id: materialId, driveFileId: "file", title: "Тестова книга", name: "test.epub", format: "epub", pageCount: 2 }); f.settings.mockResolvedValue(bookFixture.settings); const builder = { eq: () => builder, order: () => builder, limit: () => builder, returns: async () => ({ data: [], error: null }) }; f.scope.mockReturnValue({ select: () => builder }); });
it("maps print pages only with verified offset and rejects invalid bounds or EPUB print requests", () => {
  expect(physicalRange({ from: 23, to: 45, numbering: "printed" }, bookFixture)).toEqual({ from: 27, to: 49 });
  expect(() => physicalRange({ from: 1, to: 2, numbering: "printed" }, { ...bookFixture, settings: { ...bookFixture.settings, printedConfirmed: false } })).toThrow();
  expect(() => physicalRange({ from: 1, to: 2, numbering: "printed" }, { ...bookFixture, format: "epub" })).toThrow();
  expect(() => physicalRange({ from: 180, to: 181, numbering: "source" }, bookFixture)).toThrow();
});
it("checks ownership before downloading an original", async () => { f.meta.mockResolvedValue(null); await expect(originalBookText(familyId, materialId)).rejects.toThrow(); expect(f.download).not.toHaveBeenCalled(); });
it("reads an actual small EPUB in spine order, no overlapping search chunks", async () => {
  f.download.mockResolvedValue(zipSync({ "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'), "book.opf": strToU8('<package><metadata><dc:title>Island</dc:title></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'), "a.xhtml": strToU8('<html><body><h1>First</h1><p>We arrived on a beautiful island with a small boat and a map.</p></body></html>'), "b.xhtml": strToU8('<html><body><h1>Second</h1><p>The next day we followed the river and discovered a quiet forest.</p></body></html>') }));
  const source = await loadAudioSource(familyId, { ...requestFixture, from: 2, to: 2 });
  expect(source.paragraphs.map(p => p.text).join(" ")).toContain("next day"); expect(source.paragraphs.map(p => p.text).join(" ")).not.toContain("arrived"); expect(f.scope).toHaveBeenCalledWith(familyId);
});
