import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ resolve: vi.fn(), view: vi.fn(), index: vi.fn(), select: vi.fn() }));
vi.mock("@/server/voice/lessonContext", async original => ({ ...await original<typeof import("@/server/voice/lessonContext")>(), resolveLessonVoiceTarget: f.resolve }));
vi.mock("@/server/lessons/literatureV3View", () => ({ getLiteratureV3LessonView: f.view, getLiteratureV3BookIndex: f.index }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => ({ select: (table: string, columns: string) => { f.select(familyId, table, columns); const chain = { eq: () => chain, maybeSingle: async () => ({ data: table === "subjects" ? { name: "Інформатика" } : { title: "Онлайн-спілкування" }, error: null }) }; return chain; } }) }));
import { homeworkSource } from "./source";
const target = { kind: "chapter", lessonId: "11111111-1111-4111-8111-111111111111", stepId: "screen" };
beforeEach(() => { vi.clearAllMocks(); f.resolve.mockResolvedValue({ subjectId: "subject", topicId: "topic", context: "Поточний екран", lessonRef: { kind: "chapter", lessonId: target.lessonId } }); f.view.mockResolvedValue({ title: "Онлайн-безпека", packageId: "package", flow: [{ kind: "screen", displayText: "Усі матеріали уроку" }, { kind: "quiz", question: { displayMd: "Що не можна публікувати?", correctIndex: 1 } }] }); f.index.mockResolvedValue([{ printedPage: 75 }, { printedPage: 75 }, { printedPage: 74 }]); });
it("derives context and trusted return links from server content and never includes private quiz keys", async () => {
  const source = await homeworkSource("family", "child", target);
  expect(source.context).toContain("Усі матеріали уроку"); expect(source.context).not.toContain("correctIndex"); expect(source.pages).toEqual([74, 75]);
  expect(source.backHref).toBe(`/literature-v3/${target.lessonId}`);
  expect(f.select).toHaveBeenCalledWith("family", "subjects", "name:name_uk");
  expect(f.resolve).toHaveBeenCalledWith("family", "child", target);
});
it("rejects friend chats, forged client fields and inaccessible lessons before reading source material", async () => {
  await expect(homeworkSource("family", "child", { kind: "friend", chatId: target.lessonId })).rejects.toThrow();
  await expect(homeworkSource("family", "child", { ...target, context: "fake source" })).rejects.toThrow();
  f.resolve.mockRejectedValueOnce(new Error("denied")); await expect(homeworkSource("other-family", "child", target)).rejects.toThrow("denied"); expect(f.view).not.toHaveBeenCalled();
});
