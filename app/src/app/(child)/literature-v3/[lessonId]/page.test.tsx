import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ view: vi.fn(), replacement: vi.fn(), nav: vi.fn(), video: vi.fn(), list: vi.fn(), index: vi.fn(), position: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, redirect: (path: string) => { throw Error(`REDIRECT:${path}`); } }));
vi.mock("@/server/auth/guards", () => ({ requireChild: async () => ({ ctx: { familyId: "family" }, profile: { id: "child" } }) }));
vi.mock("@/server/studio/links", () => ({ studioReplacementForPath: f.replacement, studioRevisionNavigation: f.nav }));
vi.mock("@/server/studio/visibility", () => ({ studioSubjectVisible: async () => true }));
vi.mock("@/server/lessons/lessonVideo", () => ({ resolveLessonVideoTopicId: f.video }));
vi.mock("@/server/lessons/literatureV3View", () => ({ getLiteratureV3LessonView: f.view, listLiteratureV3Lessons: f.list, getLiteratureV3BookIndex: f.index, getLiteratureV3ReadingPosition: f.position }));
vi.mock("@/components/course-v2/LiteratureV3LessonView", () => ({ LiteratureV3LessonScreen: () => null }));
import Page from "./page";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); f.view.mockResolvedValue({ id, subjectId: "subject", packageId: "package", packageKey: "book", status: "active", topicId: "original", title: "Міфи" }); f.replacement.mockResolvedValue("/literature-v3/new"); f.nav.mockResolvedValue(null); f.video.mockResolvedValue(null); f.list.mockResolvedValue([]); f.index.mockResolvedValue([]); f.position.mockResolvedValue(null); });
it("keeps the original link working by opening its reviewed replacement", async () => {
  await expect(Page({ params: Promise.resolve({ lessonId: id }) })).rejects.toThrow("REDIRECT:/literature-v3/new"); expect(f.replacement).toHaveBeenCalledWith("family", `/literature-v3/${id}`); expect(f.list).not.toHaveBeenCalled();
});
it("allows explicit original viewing without looping back to the replacement", async () => {
  const page = await Page({ params: Promise.resolve({ lessonId: id }), searchParams: Promise.resolve({ original: "1" }) }); expect(page.props.lesson.id).toBe(id); expect(f.replacement).not.toHaveBeenCalled();
});
it("preserves subject navigation around the new reader and refuses withdrawn Studio content", async () => {
  f.replacement.mockResolvedValue(null); f.view.mockResolvedValue({ id, subjectId: "subject", packageId: "package", packageKey: "studio.project", status: "active", topicId: "new", title: "Міфи" });
  const lessons = [{ id, href: `/literature-v3/${id}`, title: "Міфи", status: "active", orderNo: 0 }]; f.nav.mockResolvedValue({ topicId: "original", lessons });
  const page = await Page({ params: Promise.resolve({ lessonId: id }) }); expect(page.props.packageLessons).toEqual(lessons); expect(page.props.navigationTopicId).toBe("original"); expect(page.props.videoLessonTopicId).toBeNull();
  f.view.mockResolvedValue({ id, packageKey: "studio.project", status: "needs_review" }); await expect(Page({ params: Promise.resolve({ lessonId: id }) })).rejects.toThrow("NOT_FOUND");
});
it("retains the imported original when optional replacement metadata is temporarily unavailable", async () => {
  f.replacement.mockRejectedValue(Error("metadata temporarily unavailable"));
  const page = await Page({ params: Promise.resolve({ lessonId: id }) }); expect(page.props.lesson.id).toBe(id);
});
