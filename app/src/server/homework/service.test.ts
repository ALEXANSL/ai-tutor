import { beforeEach, expect, it, vi } from "vitest";
import { homeworkFixture, homeworkArtifact } from "./__fixtures__/work";
import type { HomeworkWork } from "@/lib/homework";
import type { homeworkSource } from "./source";
const f = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), save: vi.fn(), call: vi.fn(), moderate: vi.fn(), event: vi.fn(), pages: vi.fn() }));
vi.mock("./store", () => ({ readHomework: f.read, createHomework: f.create, saveHomework: f.save }));
vi.mock("@/server/lessons/tutorModel", () => ({ callLessonTutor: f.call, tutorFailureMessage: () => "Не вдалося отримати відповідь. Запит залишився у полі — спробуй ще раз." }));
vi.mock("@/server/safety/moderate", () => ({ moderateMessage: f.moderate }));
vi.mock("@/server/safety/events", () => ({ recordSafetyEvent: f.event }));
vi.mock("@/server/lessons/chatPages", () => ({ resolveChatPages: f.pages }));
import { beginHomework, recoverHomework, runHomework } from "./service";
let work: HomeworkWork | null;
const source = { target: homeworkFixture().target, lessonKey: "chapter:lesson", lessonTitle: "Онлайн-спілкування", backHref: "/lesson", context: "Сторінка 75 про захист даних", subject: "Інформатика", topic: "Безпека", pages: [75], resolved: { context: "Урок", lessonRef: { kind: "chapter", lessonId: "lesson" } } } as Awaited<ReturnType<typeof homeworkSource>>;
const input = { requestId: "next", revision: 0, question: "Додай приклади", format: "docx" as const, pages: [75], files: [] };
beforeEach(() => {
  vi.clearAllMocks(); work = homeworkFixture();
  f.read.mockImplementation(async () => structuredClone(work));
  f.create.mockImplementation(async (_f, _i, value) => { work = value; });
  f.save.mockImplementation(async (_f, _id, previous, changes) => { if (work?.revision !== previous.revision) throw new Error("stale"); work = { ...previous, ...changes, revision: previous.revision + 1 }; return structuredClone(work); });
  f.moderate.mockResolvedValue({ severity: "none" }); f.event.mockResolvedValue({}); f.pages.mockResolvedValue({ documents: [], context: "Сторінка 75" });
  f.call.mockResolvedValue({ result: { message: "Додав приклади", artifact: homeworkArtifact } });
});
it("deduplicates accepted request IDs and blocks another paid turn while one is running", async () => {
  const first = await beginHomework("family", "child", "id", source, input); expect(first.started).toBe(true);
  expect((await beginHomework("family", "child", "id", source, input)).started).toBe(false);
  await expect(beginHomework("family", "child", "id", source, { ...input, requestId: "another", revision: 1 })).rejects.toThrow("готується");
  expect(f.call).not.toHaveBeenCalled();
});
it("includes real lesson context, prior artifact, dialogue and selected pages when revising", async () => {
  await beginHomework("family", "child", "id", source, input);
  await runHomework("family", "child", "id", "next", source, { names: [], documents: [], text: "" });
  const request = f.call.mock.calls[0]![0]; const prompt = JSON.parse(request.prompt);
  expect(prompt.subject).toBe("Інформатика"); expect(prompt.previousArtifact.title).toBe(homeworkArtifact.title); expect(prompt.history[0].request).toBe("Підготуй роботу"); expect(prompt.selectedPages).toContain("75");
  expect(request.system).toContain("ПРАВИЛА БЕЗПЕКИ"); expect(work?.state).toBe("ready"); expect(work?.turns.at(-1)?.answer).toBe("Додав приклади");
});
it("keeps the last successful artifact after failures and never automatically retries a model call", async () => {
  await beginHomework("family", "child", "id", source, input); f.call.mockRejectedValueOnce(new Error("timeout"));
  await runHomework("family", "child", "id", "next", source, { names: [], documents: [], text: "" });
  expect(work?.state).toBe("failed"); expect(work?.error).not.toContain("залишився у полі"); expect(work?.error).toContain("збережено в діалозі"); expect(work?.result?.artifact).toEqual(homeworkArtifact);
  await runHomework("family", "child", "id", "next", source, { names: [], documents: [], text: "" }); expect(f.call).toHaveBeenCalledTimes(1);
});
it("handles urgent moderation before content generation and clears the visible artifact", async () => {
  await beginHomework("family", "child", "id", source, input); f.moderate.mockResolvedValue({ severity: "urgent" });
  await runHomework("family", "child", "id", "next", source, { names: [], documents: [], text: "" });
  expect(f.call).not.toHaveBeenCalled(); expect(work?.result?.artifact).toBeNull(); expect(f.event).toHaveBeenCalled();
});
it("marks an expired worker uncertain without a new paid request", async () => {
  work = homeworkFixture({ state: "running", activeRequestId: "old", updatedAt: new Date(Date.now() - 400000).toISOString() });
  await recoverHomework("family", "id", work); expect(work?.state).toBe("failed"); expect(f.call).not.toHaveBeenCalled();
});
it("creates a new work and rejects stale revisions or a different lesson", async () => {
  await expect(beginHomework("family", "child", "id", source, { ...input, revision: 8 })).rejects.toThrow();
  await expect(beginHomework("family", "child", "id", { ...source, lessonKey: "other" }, input)).rejects.toThrow();
  work = null; await beginHomework("family", "child", "id", source, input); expect(work!.context).toContain("75"); expect(f.create).toHaveBeenCalledOnce();
});
