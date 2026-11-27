import { expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import sharp from "sharp";
import { buildLessonPptx } from "./design";
import { speakerNotes } from "./notes";
import type { LessonSlidePlan } from "@/lib/lesson-slide-plan";

it("places the stored picture with its credit and never draws decorative shapes", async () => {
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#447777" } }).jpeg().toBuffer();
  const slide: LessonSlidePlan["slides"][number] = { heading: "Мінерали", takeaway: "Кристали мають різну форму.", caption: "Грані кристала", photoQuery: "quartz", imagePrompt: "quartz crystal", narration: "Розглянь грані.",
    visual: { kind: "photo", path: "p.jpg", credit: "Quartz · A. Author · CC BY 4.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:Quartz" },
    drawing: [{ shape: "triangle", x: 20, y: 10, width: 40, height: 45, color: "teal" }] };
  const bytes = await buildLessonPptx("Географія", { slides: [slide, { ...slide, heading: "Форма кристала", visual: { kind: "ai", path: "a.jpg", credit: "Ілюстрація створена ШІ" } }, { ...slide, heading: "Без картинки", visual: { kind: "none" } }] }, [jpeg, jpeg, undefined]);
  const parts = unzipSync(bytes);
  const xml = (n: number) => strFromU8(parts[`ppt/slides/slide${n}.xml`]!);
  expect(xml(1)).toContain("<p:pic>"); expect(xml(1)).toContain("CC BY 4.0");
  expect(xml(2)).toContain("<p:pic>"); expect(xml(2)).toContain("Ілюстрація створена ШІ");
  expect(xml(3)).not.toContain("<p:pic>");
  for (const n of [1, 2, 3]) expect(xml(n)).not.toContain('prst="triangle"');
  expect(speakerNotes(bytes)).toEqual([expect.stringContaining("CC BY 4.0"), "Розглянь грані.", "Розглянь грані."]);
});
