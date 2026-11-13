import { beforeEach, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { bookFixture, requestFixture, materialId, familyId } from "./__fixtures__/part";
const f = vi.hoisted(() => ({ meta: vi.fn(), settings: vi.fn(), download: vi.fn(), scope: vi.fn() }));
vi.mock("@/server/books/reader", () => ({ getBookMaterialMeta: f.meta }));
vi.mock("@/server/drive/google", () => ({ isValidDriveId: () => true, downloadFile: f.download }));
vi.mock("@/server/drive/service", () => ({ getDriveToken: async () => async () => "test" }));
vi.mock("./store", () => ({ readLibrarySettings: f.settings, SETTINGS_TYPE: "audiobook.book", documentId: (v: string) => v, defaultLibrarySettings: { author: "", printedOffset: 0, printedConfirmed: false, chapters: [] } }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: f.scope }));
import { physicalRange, originalBookText, loadAudioSource, selectedAudioParagraph, libraryBook } from "./library";
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

it("validates the selected paragraph against its owned book and frozen boundaries", () => {
  const paragraph = { id: "paragraph", title: "§16. Тема", from: 86, to: 91 };
  const book = { ...bookFixture, paragraphs: [paragraph] };
  expect(selectedAudioParagraph({ ...requestFixture, paragraphId: "paragraph", from: 86, to: 91 }, book)).toEqual(paragraph);
  expect(() => selectedAudioParagraph({ ...requestFixture, paragraphId: "foreign", from: 86, to: 91 }, book)).toThrow();
  expect(() => selectedAudioParagraph({ ...requestFixture, paragraphId: "paragraph", from: 85, to: 91 }, book)).toThrow();
});
it("recovers a blank PDF text layer from own indexed pages, but never silently drops a missing page", async () => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("A complete first page with real narrative text.", { x: 30, y: 500, font }); pdf.addPage();
  f.download.mockResolvedValue(new Uint8Array(await pdf.save())); f.meta.mockResolvedValue({ id: materialId, driveFileId: "file", title: "Book", name: "book.pdf", format: "pdf", pageCount: 2 });
  let indexed = [{ page: 2, text: "An indexed second page with its complete content for review.", ordinal: 1 }];
  f.scope.mockReturnValue({ select: (table: string) => { const chain = { eq: () => chain, gte: () => chain, lte: () => chain, order: () => chain, limit: () => chain, returns: async () => ({ data: table === "chunks" ? indexed : [], error: null }) }; return chain; } });
  const source = await loadAudioSource(familyId, { ...requestFixture, from: 1, to: 2 }); expect(source.paragraphs.map(p => p.text).join(" ")).toContain("indexed second page"); expect(source.notes).toContain("індексованого");
  indexed = []; await expect(loadAudioSource(familyId, { ...requestFixture, from: 1, to: 2 })).rejects.toThrow("сторінки 2");
});

it("includes the next heading's page so a paragraph is not cut at the previous page edge", async () => {
  f.meta.mockResolvedValue({ id: materialId, driveFileId: "file", title: "Book", name: "book.pdf", format: "pdf", pageCount: 10 });
  f.scope.mockReturnValue({ select: (table: string) => { const chain = { eq: () => chain, order: () => chain, limit: () => chain, returns: async () => ({ data: table === "topics" ? [{ id: "one", title: "§16. Перша тема", page_from: 2, page_to: 4 }, { id: "two", title: "§17. Наступна тема", page_from: 5, page_to: 7 }] : [], error: null }) }; return chain; } });
  expect((await libraryBook(familyId, materialId))?.paragraphs?.[0]).toEqual({ id: "one", title: "§16. Перша тема", from: 2, to: 5 });
});
