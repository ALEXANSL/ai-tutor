import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ subject: vi.fn(), lesson: vi.fn() }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("@/server/lessons/literatureV3View", () => ({ getLiteratureV3LessonView: f.lesson }));
vi.mock("@/server/lessons/literatureView", () => ({ getLiteratureLessonView: vi.fn() }));
vi.mock("@/server/lessons/literatureV2View", () => ({ getLiteratureV2LessonView: vi.fn() }));
import { lessonReadingSource, readingPlainText } from "./reading-source";
const poem = "Перший рядок вірша\nДругий рядок вірша\n\nПриспів повторюється\nПриспів повторюється";
beforeEach(() => { vi.clearAllMocks(); f.subject.mockResolvedValue({ id: "subject", topics: [{ id: "topic", literatureV3LessonId: "lesson" }] }); f.lesson.mockResolvedValue({ subjectId: "subject", topicId: "topic", status: "active", flow: [{ kind: "screen", displayText: "Переказ і питання" }, { kind: "reading", workTitle: "Вірш", workAuthor: "Автор", displayText: poem, ttsText: "Скорочена підказка" }] }); });
it("retains the entire supplied poem, stanzas and repeated refrain and excludes summary/questions/TTS paraphrases", async () => {
  const result = await lessonReadingSource("family", "subject", "topic");
  expect(result[1]!.text).toBe(poem); const text = result.map(p=>p.text).join("\n\n");
  expect(text).not.toContain("Переказ"); expect(text).not.toContain("Скорочена"); expect(text.match(/Приспів повторюється/g)).toHaveLength(2);
});
it("does not substitute a summary when a literary original is absent, or read another family's topic", async () => {
  f.lesson.mockResolvedValue({ subjectId: "other", topicId: "topic", status: "active", flow: [] });
  await expect(lessonReadingSource("family", "subject", "topic")).rejects.toThrow("недоступний");
  f.lesson.mockResolvedValue({ subjectId: "subject", topicId: "topic", status: "active", flow: [{ kind: "screen", displayText: "Переказ" }] });
  await expect(lessonReadingSource("family", "subject", "topic")).rejects.toThrow("немає окремого тексту");
});
it("removes display markup without rewriting literary words or line breaks", () => {
  expect(readingPlainText("# Назва\n\n**Перший рядок**\nДругий рядок")).toBe("Назва\n\nПерший рядок\nДругий рядок");
});
