import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/server/lessons/videoLessons", () => ({ listVideoLessonsForSubject: mocks.list }));
vi.mock("./VideoLessonButton", () => ({ VideoLessonButton: ({ topicId, title }: { topicId: string; title: string }) => <button data-topic={topicId}>{title}</button> }));
import { SubjectVideoLessons, TopicVideoSupplement } from "./SubjectVideoLessons";
const videos = ["16", "17", "18–19"].map(number => ({ id: number, topicId: `hidden-${number}`, topicTitle: `Параграф ${number}`, sizeBytes: 100, createdAt: "" }));
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue(videos); });
describe("additional videos remain reachable without changing text topics", () => {
  it("renders all three old attachments without requiring them in the filtered topic list", async () => {
    const html = renderToStaticMarkup(await SubjectVideoLessons({ familyId: "family", subjectId: "history" }));
    for (const video of videos) expect(html).toContain(`data-topic="${video.topicId}"`);
    expect(html).toContain("<details"); expect(html).toContain("<summary"); expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
    expect(mocks.list).toHaveBeenCalledWith("family", "history"); expect(html).not.toContain("signedUrl");
  });
  it("offers an existing topic's video within its lesson as optional material", async () => {
    const html = renderToStaticMarkup(await TopicVideoSupplement({ familyId: "family", subjectId: "history", topicId: "hidden-17", title: "Lesson" }));
    expect(html).toContain('data-topic="hidden-17"'); expect(html).toContain("Додатково до уроку");
  });
  it("does not affect a lesson with no video or an unavailable optional catalog", async () => {
    expect(await TopicVideoSupplement({ familyId: "family", subjectId: "history", topicId: "other", title: "Other" })).toBeNull();
    mocks.list.mockRejectedValue(new Error("DB unavailable"));
    expect(await TopicVideoSupplement({ familyId: "family", subjectId: "history", topicId: "any", title: "Lesson" })).toBeNull();
    const html = renderToStaticMarkup(await SubjectVideoLessons({ familyId: "family", subjectId: "history" })); expect(html).toContain("Текстові уроки доступні");
  });
});
