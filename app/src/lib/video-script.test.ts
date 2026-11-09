import { expect, it } from "vitest";
import { exportVideoScript, NO_VISUAL_TEXT, videoScenesSchema, type VideoDraft } from "./video-script";
const draft: VideoDraft = { version: 1, title: "§16. Історія", provider: "openai", model: "test", minutes: 3, sourceHash: "a".repeat(64), createdAt: "2026-11-09", scenes: [1, 2].map(n => ({ title: `Сцена ${n}`, narration: `Точна озвучка ${n}.`, visualPrompt: `A historical scene ${n}`, sourceBlockIds: ["b1"] })) };
it("keeps narration separate from instructions and preserves scene order", () => {
  expect(exportVideoScript(draft, "narration")).toBe("Точна озвучка 1.\n\nТочна озвучка 2.");
  const brief = exportVideoScript(draft, "brief");
  expect(brief.indexOf("СЦЕНА 1")).toBeLessThan(brief.indexOf("СЦЕНА 2"));
  expect(brief).toContain("Не імпровізуй");
  expect(brief).toContain("Вимкни автоматичні субтитри");
  expect(brief.split(NO_VISUAL_TEXT)).toHaveLength(4); // global + every scene
  expect(exportVideoScript(draft, "visuals")).not.toContain("Точна озвучка");
});
it("requires narration, a visual prompt and source references in every scene", () => {
  expect(videoScenesSchema.safeParse({ scenes: [{ title: "Сцена", narration: "Текст", visualPrompt: "" }] }).success).toBe(false);
});
