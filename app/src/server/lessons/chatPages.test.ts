import { beforeEach, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
const f = vi.hoisted(() => ({ index: vi.fn(), asset: vi.fn(), download: vi.fn(), filters: [] as [string, unknown][], family: "" }));
vi.mock("./literatureV3View", () => ({ getLiteratureV3BookIndex: f.index }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => { f.family = family; return { select: () => { const chain = { eq: (field: string, value: unknown) => { f.filters.push([field, value]); return chain; }, maybeSingle: f.asset }; return chain; } }; } }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage: { from: (bucket: string) => ({ download: (path: string) => f.download(bucket, path) }) } }) }));
import { resolveChatPages, selectedPdfPages } from "./chatPages";
const ref = { kind: "chapter" as const, lessonId: "lesson", packageId: "book", currentItemId: "step" };
beforeEach(() => { f.filters.length = 0; f.index.mockReset().mockResolvedValue([{ printedPage: 20, assetId: "asset", bundlePdfPage: 2 }]); f.asset.mockReset().mockResolvedValue({ data: { storage_path: "family/book/lesson.pdf", kind: "lesson_pdf", mime_type: "application/pdf" } }); f.download.mockReset(); });
async function pdf() { const document = await PDFDocument.create(); for (const width of [100, 200, 300]) document.addPage([width, 400]); return document.save(); }
it("copies only requested physical PDF pages, not the whole book", async () => {
  const output = await PDFDocument.load(await selectedPdfPages(await pdf(), [2]));
  expect(output.getPageCount()).toBe(1); expect(output.getPage(0).getWidth()).toBe(200);
  await expect(selectedPdfPages(await pdf(), [4])).rejects.toThrow("сторінку");
});
it("derives package and file paths server-side and distinguishes printed 20 from PDF page 2", async () => {
  f.download.mockResolvedValue({ data: new Blob([Buffer.from(await pdf())]) });
  const result = await resolveChatPages("family", ref, { printedPages: [20] });
  const output = await PDFDocument.load(Buffer.from(result.documents[0]!.data, "base64"));
  expect(output.getPageCount()).toBe(1); expect(output.getPage(0).getWidth()).toBe(200);
  expect(result.context).toContain("друкована сторінка підручника 20");
  expect(f.family).toBe("family"); expect(f.filters).toContainEqual(["package_id", "book"]);
  expect(f.download).toHaveBeenCalledWith("course_assets", "family/book/lesson.pdf");
});
it("rejects forged packages, absent pages and more than two pages before downloading or calling AI", async () => {
  await expect(resolveChatPages("family", ref, { printedPages: [20], packageId: "other" })).rejects.toThrow();
  await expect(resolveChatPages("family", ref, { printedPages: [1, 2, 3] })).rejects.toThrow();
  await expect(resolveChatPages("family", ref, { printedPages: [999] })).rejects.toThrow("немає");
  await expect(resolveChatPages("family", undefined, { printedPages: [20] })).rejects.toThrow("віртуальним");
  expect(f.download).not.toHaveBeenCalled();
});
it("fails on unavailable/oversized PDFs instead of silently dropping the page", async () => {
  f.download.mockResolvedValue({ data: { size: 21 * 1024 * 1024 } });
  await expect(resolveChatPages("family", ref, { printedPages: [20] })).rejects.toThrow("20 МБ");
});
