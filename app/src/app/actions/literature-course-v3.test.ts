import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ files: new Map<string, Blob>(), download: vi.fn(), persist: vi.fn(), remove: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: async () => ({ familyId: "family-one" }) }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "subject", name_uk: "Географія" }, error: null }) }) }) }) }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage: { from: () => ({ download: mock.download, remove: mock.remove }) } }) }));
vi.mock("@/server/lessons/literatureV3Persist", () => ({ persistLiteratureV3Package: mock.persist }));
const { importLiteratureV3Action } = await import("./literature-course-v3");
const fixture = join(__dirname, "../../server/lessons/__fixtures__/literature-course-v3");
const base = {
  subjectId: "00000000-0000-4000-8000-000000000001",
  packageStoragePath: "family-one/package.json", courseStoragePath: "family-one/course.json",
  readingsStoragePath: "family-one/readings.json", teacherStoragePath: "family-one/teacher.json",
};
beforeEach(() => {
  mock.files.clear(); vi.clearAllMocks();
  for (const [path, source] of [[base.packageStoragePath, "package.json"], [base.courseStoragePath, "public/course.json"], [base.readingsStoragePath, "public/readings.json"], [base.teacherStoragePath, "private/teacher.json"]]) {
    mock.files.set(path!, new Blob([readFileSync(join(fixture, source!))]));
  }
  mock.download.mockImplementation(async (path: string) => ({ data: mock.files.get(path), error: null }));
  mock.remove.mockResolvedValue({ error: null });
  mock.persist.mockResolvedValue({ lessonsImported: 1, screensImported: 1, worksImported: 0, readingItemsImported: 0, biographiesImported: 0, questionsImported: 1, questionKeysImported: 1, pagesImported: 0, assetsUploaded: 0, assetsMissing: [], assetUploadFailures: [], assetReuseWarnings: [] });
});
describe("universal chapter import optional media", () => {
  it("imports core documents without any catalog or ZIP uploads", async () => {
    const result = await importLiteratureV3Action(base);
    expect(result.status).toBe("ok"); expect(mock.download).toHaveBeenCalledTimes(4);
    const parsed = mock.persist.mock.calls[0]![2];
    expect(parsed.assets).toEqual([]); expect(parsed.pages).toEqual([]); expect(parsed.errors).toEqual([]);
    expect(mock.persist.mock.calls[0]![3].size).toBe(0);
    expect(mock.remove).toHaveBeenCalledWith(Object.values(base).slice(1));
  });
  it("imports a media catalog without a ZIP so files may be added later", async () => {
    mock.files.set("family-one/assets.json", new Blob([JSON.stringify({ items: [{ id: "PDF-L001", kind: "lesson_pdf", path: "lesson_pdfs/L001.pdf", mime_type: "application/pdf" }] })]));
    expect((await importLiteratureV3Action({ ...base, assetsStoragePath: "family-one/assets.json" })).status).toBe("ok");
    expect(mock.persist.mock.calls[0]![2].assets).toHaveLength(1); expect(mock.persist.mock.calls[0]![3].size).toBe(0);
  });
  it("uploads the separate lessons ZIP and resolves its PDF against catalog paths", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70]);
    mock.files.set("family-one/assets.json", new Blob([JSON.stringify({ items: [{ id: "PDF-L001", kind: "lesson_pdf", path: "lesson_pdfs/L001.pdf", mime_type: "application/pdf" }] })]));
    mock.files.set("family-one/lessons.zip", new Blob([zipSync({ "lessons/L001.pdf": pdf })]));
    const result = await importLiteratureV3Action({ ...base, assetsStoragePath: "family-one/assets.json", lessonPdfsZipStoragePath: "family-one/lessons.zip" });
    expect(result.status).toBe("ok"); expect(mock.persist.mock.calls[0]![3].get("lesson_pdfs/L001.pdf")).toEqual(pdf);
    expect(mock.remove.mock.calls[0]![0]).toContain("family-one/lessons.zip");
  });
  it("rejects another family's optional PDF ZIP before reading storage", async () => {
    expect(await importLiteratureV3Action({ ...base, lessonPdfsZipStoragePath: "other-family/lessons.zip" })).toMatchObject({ status: "error" });
    expect(mock.download).not.toHaveBeenCalled(); expect(mock.persist).not.toHaveBeenCalled();
  });
  it("imports all seven JSON documents and two separately uploaded ZIPs", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70]);
    const image = new Uint8Array([82, 73, 70, 70]);
    mock.files.set("family-one/assets.json", new Blob([JSON.stringify({ items: [
      { id: "PDF-L001", kind: "lesson_pdf", path: "lesson_pdfs/L001.pdf", mime_type: "application/pdf" },
      { id: "figure", kind: "textbook_illustration", path: "assets/figures/F001.webp", mime_type: "image/webp" },
    ] })]));
    mock.files.set("family-one/pages.json", new Blob([JSON.stringify({ items: [] })]));
    const manifest = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
    mock.files.set("family-one/task_tables.json", new Blob([JSON.stringify({ schema_version: manifest.schema_version, book_id: manifest.book_id, items: [] })]));
    mock.files.set("family-one/assets.zip", new Blob([zipSync({ "assets/figures/F001.webp": image })]));
    mock.files.set("family-one/lessons.zip", new Blob([zipSync({ "lessons/L001.pdf": pdf })]));
    const result = await importLiteratureV3Action({ ...base,
      assetsStoragePath: "family-one/assets.json", pagesStoragePath: "family-one/pages.json", taskTablesStoragePath: "family-one/task_tables.json",
      binariesZipStoragePath: "family-one/assets.zip", lessonPdfsZipStoragePath: "family-one/lessons.zip",
    });
    expect(result.status).toBe("ok");
    expect(mock.persist.mock.calls[0]![2].errors).toEqual([]);
    expect(mock.persist.mock.calls[0]![3]).toEqual(new Map([["assets/figures/F001.webp", image], ["lesson_pdfs/L001.pdf", pdf]]));
    expect(mock.download).toHaveBeenCalledTimes(9);
  });
});
