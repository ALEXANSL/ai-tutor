import { expect, it } from "vitest";
import { studioVisualSchema } from "@/lib/studio";
import { applyStudioRepair } from "./repair";
import { studioLessonFixture, studioVisualFixture } from "./__fixtures__/project";
import { studioVisualSvg } from "./visual";
const label = "3. Якщо ні: чи використовують її як будівельну, хімічну або харчову сировину?";
const visual = { ...studioVisualFixture, items: [{ label, detail: "Так — це нерудна копалина" }, { label: "4. Поясни використання", detail: "Назви, для чого її застосовують і яка властивість це пояснює" }] };
const unit = { content: studioLessonFixture, visuals: [studioVisualFixture], review: null };
const fix = { diagnosis: "Схему обірвано обмеженням довжини підпису", reviewAdvice: "Звір повний текст", blocks: [], questions: [], visuals: [visual], title: null, objectives: null, sourceIds: null, enrichmentNote: null, adultAssistance: null };
it("accepts the complete mineral decision step and sizes its SVG rows to avoid overlap", () => {
  expect(studioVisualSchema.parse(visual).items[0]!.label).toBe(label);
  const svg = studioVisualSvg(visual);
  expect([...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map(match => match[1]).join(" ")).toContain(label);
  expect(svg).not.toContain("1. 3.");
  const rectangles = [...svg.matchAll(/rx="10" width="650" height="(\d+)"/g)];
  expect(Number(rectangles[0]![1])).toBeGreaterThan(80);
});
it("replaces only the explicit diagrams and preserves all approved lesson content", () => {
  const result = applyStudioRepair(unit, fix);
  expect(result.unit.content).toEqual(unit.content); expect(result.unit.visuals).toEqual([visual]);
  expect(unit.visuals).toEqual([studioVisualFixture]);
});
it("rejects out-of-range and duplicate replacement indices", () => {
  expect(() => applyStudioRepair(unit, { ...fix, blocks: [{ blockIndex: 7, replacement: studioLessonFixture.blocks[0] }] })).toThrow("REF");
  const patch = { blockIndex: 0, replacement: studioLessonFixture.blocks[0] };
  expect(() => applyStudioRepair(unit, { ...fix, blocks: [patch, patch] })).toThrow("DUPLICATE");
});
