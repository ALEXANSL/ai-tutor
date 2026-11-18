import { expect, it } from "vitest";
import { studioPackage } from "./publish";
import { studioProjectFixture, studioPlanFixture, studioLessonFixture, studioVisualFixture } from "./__fixtures__/project";
import { studioVisualSvg } from "./visual";
const project = () => studioProjectFixture({ state: "ready", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: { verdict: "pass", issues: [], summary: "Добре" } }] });
it("converts reviewed content to the existing V3 reader with separate quiz keys, safe diagrams and stable namespaced IDs", () => {
  const { parsed, files } = studioPackage("project", project());
  expect(parsed.errors).toEqual([]); expect(parsed.manifest?.book_id).toBe("studio.project");
  expect(parsed.lessons[0]!.screens).toHaveLength(studioLessonFixture.blocks.length);
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
it("publishes a 24-lesson course as tap-only single-choice quizzes without dropping lessons", () => {
  const value = project(); value.request.lessonCount = 24; value.plan = { ...studioPlanFixture, lessons: Array.from({ length: 24 }, (_, i) => ({ title: `Урок ${i+1}`, goal: "Навчальний результат" })) };
  value.units = Array.from({ length: 24 }, (_, i) => ({ ...value.units[0]!, content: { ...studioLessonFixture, title: `Урок ${i+1}` } }));
  const result = studioPackage("long-course", value).parsed;
  expect(result.errors).toEqual([]); expect(result.lessons).toHaveLength(24); expect(result.tasks).toHaveLength(48);
  expect(result.tasks.every(task => task.response_type === "single_choice" && task.options.length === 3)).toBe(true);
  expect(result.taskKeys.every(key => key.grading?.method === "single_choice")).toBe(true);
});
it("publishes parent-selected photos inside their assigned lesson block with durable source credits", () => {
  const value = project(); value.units[0]!.illustrations = [{ id: "photo", blockIndex: 1, title: "Кварц", caption: "Кристал кварцу", sourceUrl: "https://commons.wikimedia.org/wiki/File:Quartz.jpg", credit: "Автор фото", license: "CC BY 4.0", storagePath: "private/path", byteSize: 3 }];
  const result = studioPackage("project", value, new Map([["assets/L1P1.jpg", new Uint8Array([1, 2, 3])]]));
  expect(result.parsed.errors).toEqual([]);
  expect(result.parsed.lessons[0]!.screens[1]!.asset_ids).toContain("L1P1");
  expect(result.parsed.assets.find(asset => asset.id === "L1P1")?.caption).toContain("CC BY 4.0");
  expect(result.parsed.assets.find(asset => asset.id === "L1P1")?.caption).toContain("https://commons.wikimedia.org/");
  expect(() => studioPackage("project", value)).toThrow("Ілюстрація відсутня");
});

it("keeps provenance out of the child flow while preserving full narration and practical safety",()=>{
 const value=project(), result=studioPackage("project",value).parsed;
 expect(result.lessons[0]!.flow.some(item=>item.ref_id.endsWith("Sources"))).toBe(false);
 const first=result.lessons[0]!.screens[0]!; expect(first.content.tts.text).toContain(studioLessonFixture.blocks[0]!.text.trim());
 expect(result.lessons[0]!.screens.find(screen=>screen.step_type==="practice")!.content.tts.text).toContain(value.units[0]!.content.adultAssistance);
 expect(result.lessons[0]!.screens.every(screen=>!screen.content.display.includes(value.units[0]!.content.enrichmentNote))).toBe(true);
});
it("never adds Ukrainian service wording to a native-language listening block",()=>{
 const value=project(); value.units[0]!.content=structuredClone(value.units[0]!.content);
 value.units[0]!.content.blocks[0]={...value.units[0]!.content.blocks[0]!,narrationLanguage:"en-GB",narration:"Hello, how are you?"};
 const result=studioPackage("project",value).parsed;expect(result.lessons[0]!.screens[0]!.content.tts.text).toBe("Hello, how are you?");
});

it("adds ten missing diagnostic questions with one edit and exports all twelve to the lesson reader", async () => {
  const { applyStudioRepair } = await import("./repair");
  const draft = project();
  const original = draft.units[0]!;
  const questions = Array.from({length:10}, (_,i) => ({
    questionIndex:i + 2, replacement:{...original.content.questions[0]!, prompt:"Завдання " + (i + 3)},
  }));
  const change = {diagnosis:"Додаємо перевірку за кожною темою.", reviewAdvice:"Перевір усі відповіді.",blocks:[],questions,visuals:null,title:null,objectives:null,sourceIds:null,enrichmentNote:null,adultAssistance:null};
  const { unit } = applyStudioRepair(original, change);
  expect(unit.content.blocks).toEqual(original.content.blocks);
  expect(unit.content.questions.slice(0,2)).toEqual(original.content.questions);
  expect(unit.review).toBeNull();
  expect(() => applyStudioRepair(original,{...change, questions:questions.slice(1)})).toThrow("STUDIO-REPAIR-REF");
  draft.units[0] = {...unit,review:original.review};
  const { parsed } = studioPackage("diagnostic",draft);
  expect(parsed.errors).toEqual([]);
  expect(parsed.lessons[0]!.task_ids).toHaveLength(12);
  expect(parsed.taskKeys).toHaveLength(12);
});
