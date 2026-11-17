import { beforeEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { studioProjectFixture, studioLessonFixture } from "./__fixtures__/project";
const f = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), upload: vi.fn(), fetch: vi.fn() }));
vi.mock("./store", () => ({ readStudioProject: f.read, saveStudioProject: f.save }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ client: { storage: { from: () => ({ upload: f.upload }) } } }) }));
import { commonsImageUrl, commonsPictures, downloadCommonsPicture, normaliseIllustration, saveIllustration, editableIllustrationProject } from "./illustrations";
const target = { id: "11111111-1111-4111-8111-111111111111", revision: 0, lessonIndex: 0, blockIndex: 1 };
const metadata = { title: "Кварц", caption: "Кристал кварцу", sourceUrl: "https://commons.wikimedia.org/wiki/File:Quartz.jpg", credit: "Фотограф", license: "CC BY 4.0" };
beforeEach(() => { vi.clearAllMocks(); f.read.mockResolvedValue(studioProjectFixture({ state: "published", publication: { subjectId: "subject", packageId: "package", lessons: [] }, units: [{ content: studioLessonFixture, visuals: [], review: { verdict: "pass", summary: "Добре", issues: [] } }] })); f.upload.mockResolvedValue({ error: null }); vi.stubGlobal("fetch", f.fetch); });
it("only fetches the exact Commons image host over HTTPS, never credentials or arbitrary redirects", () => {
  expect(commonsImageUrl("https://upload.wikimedia.org/wikipedia/commons/a/aa/photo.jpg")).toContain("photo.jpg");
  expect(commonsImageUrl("https://thumb.wikimedia.org/wikipedia/commons/thumb/a/aa/photo.jpg/1000px-photo.jpg")).toContain("1000px-photo.jpg");
  for (const url of ["http://upload.wikimedia.org/wikipedia/commons/a.jpg", "https://upload.wikimedia.org.evil.com/wikipedia/commons/a.jpg", `https://user${"@"}upload.wikimedia.org/wikipedia/commons/a.jpg`, "https://127.0.0.1/a.jpg", "https://upload.wikimedia.org/other/a.jpg"]) expect(() => commonsImageUrl(url)).toThrow();
});
it("normalises a real image, strips metadata and limits its displayed dimensions", async () => {
  const input = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "blue" } }).png().toBuffer();
  const output = await normaliseIllustration(input); const meta = await sharp(output).metadata();
  expect(meta.format).toBe("jpeg"); expect(meta.width).toBe(1600); expect(meta.height).toBe(800); expect(meta.exif).toBeUndefined();
  await expect(normaliseIllustration(new TextEncoder().encode("<svg><script/></svg>"))).rejects.toThrow();
});
it("preserves lesson text and its existing publication, saving the image only as a draft update", async () => {
  const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: "blue" } }).png().toBuffer();
  await saveIllustration("family", target, image, metadata);
  expect(f.read).toHaveBeenCalledWith("family", target.id);
  const changes = f.save.mock.calls[0]![3]; expect(changes.state).toBe("ready"); expect(changes.publicationRevision).toBe(true);
  expect(changes.units[0].content).toEqual(studioLessonFixture);
  expect(changes.units[0].illustrations[0]).toMatchObject({ ...metadata, blockIndex: 1 });
  expect(f.upload.mock.calls[0]![0]).toContain(`studio-images/family/${target.id}/`);
});
it("rejects active work, stale revisions, foreign/missing projects and absent block targets", async () => {
  f.read.mockResolvedValue(null); await expect(editableIllustrationProject("other-family", target)).rejects.toThrow();
  f.read.mockResolvedValue(studioProjectFixture({ state: "generating" })); await expect(editableIllustrationProject("family", target)).rejects.toThrow();
  f.read.mockResolvedValue(studioProjectFixture({ state: "ready", revision: 5 })); await expect(editableIllustrationProject("family", target)).rejects.toThrow();
  expect(f.upload).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
});
it("uses provider attribution instead of model guesses and drops unsupported external results", async () => {
  f.fetch.mockResolvedValue(Response.json({ query: { pages: { 4: { pageid: 4, title: "File:Quartz.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/wikipedia/commons/a/quartz.jpg", descriptionurl: metadata.sourceUrl, extmetadata: { Artist: { value: "<b>Фотограф</b>" }, LicenseShortName: { value: "CC BY 4.0" } } }] } } } }));
  expect(await commonsPictures("кварц")).toEqual([expect.objectContaining({ pageId: 4, credit: "Фотограф", license: "CC BY 4.0" })]);
});
it("rejects oversized or non-image remote responses before persisting anything", async () => {
  f.fetch.mockResolvedValue(new Response("bad", { headers: { "content-type": "text/html" } }));
  await expect(downloadCommonsPicture("https://upload.wikimedia.org/wikipedia/commons/a/photo.jpg")).rejects.toThrow();
  expect(f.fetch.mock.calls[0]![1].redirect).toBe("error"); expect(f.upload).not.toHaveBeenCalled();
});
