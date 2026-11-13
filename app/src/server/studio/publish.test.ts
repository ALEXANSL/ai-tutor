import { expect, it } from "vitest";
import { studioPackage } from "./publish";
import { studioProjectFixture, studioPlanFixture, studioLessonFixture, studioVisualFixture } from "./__fixtures__/project";
import { studioVisualSvg } from "./visual";
const project = () => studioProjectFixture({ state: "ready", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: { verdict: "pass", issues: [], summary: "Добре" } }] });
it("converts reviewed content to the existing V3 reader with separate quiz keys, safe diagrams and stable namespaced IDs", () => {
  const { parsed, files } = studioPackage("project", project());
  expect(parsed.errors).toEqual([]); expect(parsed.manifest?.book_id).toBe("studio.project");
  expect(parsed.lessons[0]!.screens).toHaveLength(studioLessonFixture.blocks.length + 1);
  expect(parsed.lessons[0]!.screens[0]!.content.display).toContain("На схемі:");
  expect(parsed.tasks[0]).not.toHaveProperty("correctIndex"); expect(parsed.tasks[0]).not.toHaveProperty("correct_option_ids");
  expect(parsed.taskKeys[0]!.correct_option_ids).toEqual(["o1"]); expect(files.size).toBe(1);
  expect(new TextDecoder().decode([...files.values()][0])).toContain("<svg");
  expect(parsed.lessons[0]!.screens.find(screen => screen.step_type === "code")?.content.display).toContain("```\nlocal part");
});
it("never publishes an unreviewed or incomplete course", () => {
  const draft = project(); draft.units[0]!.review = null;
  expect(() => studioPackage("project", draft)).toThrow("рецензію");
});
it("escapes model text in SVG, emits no executable or external markup, and draws dimensions numerically", () => {
  const svg = studioVisualSvg({ ...studioVisualFixture, title: '<script>alert("x")</script>', kind: "dimensions", width: 20, height: 10, unit: "см", items: [{ label: '<img onload="x">', detail: 'javascript:alert(1)' }, { label: 'Друга', detail: 'Перевір розмір' }] });
  expect(svg).not.toContain("<script"); expect(svg).not.toContain("<img"); expect(svg).not.toContain("href="); expect(svg).toContain("&lt;script&gt;"); expect(svg).toContain("20 см"); expect(svg).toContain("10 см");
});

it("keeps package namespace and surviving lesson/screen keys stable when publishing corrections", () => {
  const initial = project(); const before = studioPackage("same-project", initial).parsed;
  initial.publicationRevision = true; initial.units[0]!.content.blocks[0]!.text += "\n\nУточнений приклад.";
  const after = studioPackage("same-project", initial).parsed;
  expect(after.manifest?.book_id).toBe(before.manifest?.book_id);
  expect(after.lessons.map(lesson => lesson.id)).toEqual(before.lessons.map(lesson => lesson.id));
  expect(after.lessons[0]!.screens.map(screen => screen.id)).toEqual(before.lessons[0]!.screens.map(screen => screen.id));
  expect(after.lessons[0]!.screens[0]!.content.display).toContain("Уточнений приклад");
});
it("preserves native-language narration metadata in the published reader contract", () => {
  const value = project(); value.units[0]!.content = structuredClone(value.units[0]!.content); value.units[0]!.content.blocks[1]!.narrationLanguage = "de-DE";
  expect(studioPackage("project", value).parsed.lessons[0]!.screens[1]!.content.tts.lang).toBe("de-DE");
});
