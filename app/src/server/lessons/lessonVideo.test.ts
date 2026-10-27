import { expect, it, vi } from "vitest";
const list = vi.hoisted(() => vi.fn());
vi.mock("./videoLessons", () => ({ listVideoLessonsForSubject: list }));
import { resolveLessonVideoTopicId } from "./lessonVideo";
const video = (topicId: string, topicTitle = "§16. Цивілізації") => ({ id: topicId, topicId, topicTitle });
it("resolves multiple direct videos and old-topic videos without changing data", async () => {
  list.mockResolvedValue([video("current"), video("current")]);
  expect(await resolveLessonVideoTopicId("family", "subject", "current", "Урок")).toBe("current");
  expect(list).toHaveBeenCalledWith("family", "subject");
  list.mockResolvedValue([video("old"), video("old")]);
  expect(await resolveLessonVideoTopicId("family", "subject", "current", "§16. Цивілізації")).toBe("old");
});
it("does not guess between different same-title topics or fail the lesson if video metadata fails", async () => {
  list.mockResolvedValue([video("old-1"), video("old-2")]);
  expect(await resolveLessonVideoTopicId("family", "subject", "current", "§16. Цивілізації")).toBeNull();
  list.mockRejectedValue(new Error("Unavailable"));
  expect(await resolveLessonVideoTopicId("family", "subject", "current", "Урок")).toBeNull();
});
