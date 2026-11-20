import { expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import sharp from "sharp";
import { buildLessonPptx } from "./design";
import { speakerNotes } from "./notes";
import type { LessonSlidePlan } from "@/lib/lesson-slide-plan";

it("embeds an attributed photo and retains a native editable illustration when photo search fails", async () => {
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#447777" } }).jpeg().toBuffer();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ query: { pages: { "1": { pageid: 1, title: "File:Mineral", imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Mineral.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Mineral", extmetadata: { LicenseShortName: { value: "CC BY 4.0" }, Artist: { value: "A. Author" } } }] } } } }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg" } }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const slide: LessonSlidePlan["slides"][number] = { heading: "Мінерали", takeaway: "Кристали мають різну форму.", caption: "Грані кристала", photoQuery: "quartz", narration: "Розглянь грані.", drawing: [{ shape: "triangle", x: 20, y: 10, width: 40, height: 45, color: "teal" }] };
    const bytes = await buildLessonPptx("Географія", { slides: [slide, { ...slide, heading: "Форма кристала" }] });
    const parts = unzipSync(bytes);
    expect(strFromU8(parts["ppt/slides/slide1.xml"]!)).toContain("<p:pic>");
    expect(strFromU8(parts["ppt/slides/slide2.xml"]!)).toContain('prst="triangle"');
    expect(speakerNotes(bytes)).toEqual([expect.stringContaining("CC BY 4.0"), "Розглянь грані."]);
  } finally { vi.unstubAllGlobals(); }
});
