import { beforeEach, expect, it, vi } from "vitest";
import { requestFixture } from "./__fixtures__/part";
const f = vi.hoisted(() => ({ subject: vi.fn(), publications: vi.fn(), source: vi.fn() }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("@/server/studio/links", () => ({ studioPublicationsForSubject: f.publications }));
vi.mock("@/server/video-script/source", () => ({ loadVideoLessonSource: f.source }));
import { audioLessonBook, readyAudioLessonSource } from "./lesson-source";
const request = { ...requestFixture, materialId: "subject", from: 1, to: 1, lesson: { subjectId: "subject", topicId: "topic" } };
beforeEach(() => { vi.clearAllMocks(); f.subject.mockResolvedValue({ id: "subject", name: "Географія", topics: [{ id: "topic", title: "Тема", literatureV3LessonId: "lesson" }, { id: "old", title: "Немає уроку" }] }); f.publications.mockResolvedValue([]); f.source.mockResolvedValue({ subject: "Географія", title: "Тема", blocks: [{ title: "Пояснення", text: "Матеріал готового уроку. ".repeat(20) }] }); });
it("uses ready lesson material without touching the original book", async () => {
  const source = await readyAudioLessonSource("family", request);
  expect(source.book.format).toBe("lesson"); expect(source.range).toEqual({ from: 1, to: 1 }); expect(source.paragraphs.map(p => p.text).join(" ")).toContain("готового уроку"); expect(f.source).toHaveBeenCalledWith("family", "subject", "topic");
});
it("uses the currently published replacement instead of stale imported content", async () => {
  f.publications.mockResolvedValue([{ mode: "revision", baseTopicId: "topic", lessons: [{ topicId: "replacement" }] }]);
  await readyAudioLessonSource("family", request); expect(f.source).toHaveBeenCalledWith("family", "subject", "replacement");
});
it("rejects another family's subject, absent or unready topics and a forged source scope", async () => {
  await expect(audioLessonBook("family", { ...request, materialId: "other" })).rejects.toThrow();
  await expect(audioLessonBook("family", { ...request, lesson: { subjectId: "subject", topicId: "old" } })).rejects.toThrow();
  f.subject.mockResolvedValue(null); await expect(audioLessonBook("other-family", request)).rejects.toThrow(); expect(f.source).not.toHaveBeenCalled();
});
