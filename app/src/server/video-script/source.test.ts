import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ subject: vi.fn(), chapter: vi.fn(), math: vi.fn(), lit2: vi.fn(), lit: vi.fn(), course: vi.fn() }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("@/server/lessons/literatureV3View", () => ({ getLiteratureV3LessonView: f.chapter }));
vi.mock("@/server/lessons/mathCourseV2View", () => ({ getMathCourseV2LessonView: f.math }));
vi.mock("@/server/lessons/literatureV2View", () => ({ getLiteratureV2LessonView: f.lit2 }));
vi.mock("@/server/lessons/literatureView", () => ({ getLiteratureLessonView: f.lit }));
vi.mock("@/server/lessons/courseView", () => ({ getCourseLessonView: f.course }));
import { loadVideoLessonSource } from "./source";
const content = "Перевірений навчальний матеріал. ".repeat(12);
const base = { subjectId: "subject", topicId: "topic", status: "active" };
function subject(selector = "literatureV3LessonId") { f.subject.mockResolvedValue({ name: "Історія", topics: [{ id: "topic", title: "§16", [selector]: "lesson" }] }); }
beforeEach(() => { Object.values(f).forEach(fn => fn.mockReset()); subject(); });
it("loads ordered chapter explanation, biography and reading, never asset URLs or quiz keys", async () => {
  f.chapter.mockResolvedValue({ ...base, flow: [
    { kind: "screen", title: "Вступ", displayText: content, ttsText: "", illustrations: [{ url: "SECRET_SIGNED_URL" }] },
    { kind: "biography", authorName: "Автор", displayText: "Біографія", ttsText: "" },
    { kind: "reading", title: "Уривок", workTitle: "Твір", workAuthor: "Автор", displayText: "Текст твору", ttsText: "" },
    { kind: "quiz", question: { displayMd: "Запитання", correctOptionId: "SECRET_KEY" } },
  ] });
  const source = await loadVideoLessonSource("family", "subject", "topic");
  expect(source.blocks.map(block => block.id)).toEqual(["b1", "b2", "b3", "b4"]);
  expect(source.blocks[2]?.text).toBe("Текст твору");
  expect(JSON.stringify(source)).not.toContain("SECRET");
  expect(f.chapter).toHaveBeenCalledWith("family", "lesson", { includeIllustrations: false });
});
it("scopes the subject and rechecks ownership/identity of the resolved lesson", async () => {
  f.chapter.mockResolvedValue({ ...base, subjectId: "other-subject", flow: [] });
  await expect(loadVideoLessonSource("family", "subject", "topic")).rejects.toThrow("недоступний");
  expect(f.subject).toHaveBeenCalledWith("family", "subject");
  expect(f.chapter).toHaveBeenCalledWith("family", "lesson", expect.anything());
});
it("refuses unknown topic, archived/review lessons, quiz-only and oversized source instead of inventing or truncating", async () => {
  await expect(loadVideoLessonSource("family", "subject", "foreign-topic")).rejects.toThrow("не знайдено");
  f.chapter.mockResolvedValue({ ...base, status: "needs_review", flow: [] });
  await expect(loadVideoLessonSource("family", "subject", "topic")).rejects.toThrow("недоступний");
  f.chapter.mockResolvedValue({ ...base, flow: [{ kind: "quiz", question: { displayMd: content } }] });
  await expect(loadVideoLessonSource("family", "subject", "topic")).rejects.toThrow("недостатньо");
  f.chapter.mockResolvedValue({ ...base, flow: [{ kind: "screen", title: "Тема", displayText: "x".repeat(60_001) }] });
  await expect(loadVideoLessonSource("family", "subject", "topic")).rejects.toThrow("60 000");
});
it("reads all four older formats without exporting hidden answers", async () => {
  subject("mathCourseV2LessonId");
  f.math.mockResolvedValue({ ...base, screens: [{ title: "Правило", displayMd: content }], exercises: [{ originalNumber: "357", displayMd: "Умова" }], solution: "SECRET" });
  expect((await loadVideoLessonSource("family", "subject", "topic")).blocks[1]?.title).toContain("357");
  subject("literatureV2LessonId");
  f.lit2.mockResolvedValue({ ...base, explanation: [{ display: content }], definitions: [], screens: [], tasks: [{ originalLabel: "Завдання", prompt: { display: "Умова" }, subtasks: [] }] });
  expect((await loadVideoLessonSource("family", "subject", "topic")).blocks).toHaveLength(2);
  subject("literatureLessonId");
  f.lit.mockResolvedValue({ ...base, explanationMd: content, work: { titleUk: "Твір", excerptsUk: "Уривок", summaryUk: "Огляд", authorBioUk: "Біографія" } });
  expect((await loadVideoLessonSource("family", "subject", "topic")).blocks.map(block => block.text)).toContain("Біографія");
  subject("courseLessonId");
  f.course.mockResolvedValue({ ...base, sourceImages: [{ printedPage: 15, searchTextOcr: content, url: "SECRET_URL" }], automaticQuestions: [{ answer: "SECRET" }] });
  expect(JSON.stringify(await loadVideoLessonSource("family", "subject", "topic"))).not.toContain("SECRET");
  f.course.mockResolvedValue({ ...base, sourceImages: [{ url: "image-only" }] });
  await expect(loadVideoLessonSource("family", "subject", "topic")).rejects.toThrow("недостатньо");
});
it("retains additional spoken explanations as well as slide text", async () => {
  subject("mathCourseV2LessonId");
  f.math.mockResolvedValue({ ...base, screens: [{ title: "Правило", displayMd: content, narration: "Додаткове пояснення для слухача." }], exercises: [] });
  const source = await loadVideoLessonSource("family", "subject", "topic");
  expect(source.blocks[0]?.text).toContain(content);
  expect(source.blocks[0]?.text).toContain("Додаткове пояснення для слухача");
});
