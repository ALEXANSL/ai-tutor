import { BudgetBlockedError } from "@/server/ai/types";
import { beforeEach, expect, it, vi } from "vitest";
import type { StudioProject } from "@/lib/studio";
import { studioLessonFixture, studioPlanFixture, studioProjectFixture, studioVisualFixture } from "./__fixtures__/project";
const f = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), create: vi.fn(), enqueue: vi.fn(), call: vi.fn(), sources: vi.fn(), config: vi.fn(), prepare: vi.fn(), activate: vi.fn() }));
vi.mock("./store", () => ({ STUDIO_STEP: "studio.step", readStudioProject: f.read, saveStudioProject: f.save, createStudioProject: f.create }));
vi.mock("./sources", () => ({ loadStudioSources: f.sources }));
vi.mock("./model", () => ({ studioModelConfig: f.config, studioReservation: () => 0.1, callStudioModel: f.call }));
vi.mock("./publish", () => ({ prepareStudioPublication: f.prepare, activateStudioPublication: f.activate }));
vi.mock("@/server/jobs/runner", () => ({ enqueueJob: f.enqueue, registerJobHandler: vi.fn() }));
import { failStudioStep, pauseStudio, resumeStudio, runStudioStep, startStudio, validateStudioLesson } from "./workflow";
let project: StudioProject;
const id = "11111111-1111-4111-8111-111111111111";
const job = () => ({ id: "job", family_id: "family", type: "studio.step", payload: { projectId: id, token: project.token }, attempts: 1, max_attempts: 1 });
beforeEach(() => {
  vi.clearAllMocks(); project = studioProjectFixture(); f.read.mockImplementation(async () => structuredClone(project));
  f.save.mockImplementation(async (_family, _id, previous, changes) => { if (previous.revision !== project.revision) throw new Error("stale"); project = { ...project, ...changes, revision: project.revision + 1 }; return structuredClone(project); });
  f.enqueue.mockResolvedValue(undefined); f.config.mockResolvedValue({ route: { params: { max_tokens: 1000 } }, rates: {} });
  f.call.mockImplementation(async (_family, _id, role) => ({ result: role === "studio.plan" ? studioPlanFixture : role === "studio.author" ? studioLessonFixture : role === "studio.design" ? { visuals: [studioVisualFixture] } : { verdict: "pass", issues: [], summary: "Зміст і схема узгоджені." }, model: { provider: "openai", model: "test-model" }, costUsd: 0.02 }));
  f.prepare.mockResolvedValue({ subjectId: "new-subject", packageId: "new-package", lessons: [{ id: "new-lesson", topicId: "new-topic", title: "Координати" }] }); f.activate.mockResolvedValue(undefined);
});
const step = () => runStudioStep(job(), Date.now() + 220000);
it("stops after the plan, requires parent approval, runs independent author/design/review, and publishes only on command", async () => {
  await step(); expect(project.state).toBe("plan_ready"); expect(f.call).toHaveBeenCalledTimes(1);
  await step(); expect(f.call).toHaveBeenCalledTimes(1);
  await resumeStudio("family", id, project.revision, "approve", studioPlanFixture);
  await step(); expect(project.phase).toBe("design");
  await step(); expect(project.phase).toBe("review");
  await step(); expect(project.state).toBe("ready"); expect(project.spentUsd).toBeCloseTo(0.08); expect(project.heldUsd).toBeCloseTo(0); expect(f.prepare).not.toHaveBeenCalled();
  await resumeStudio("family", id, project.revision, "publish"); await step(); expect(project.state).toBe("published");
  expect(f.activate).toHaveBeenCalledWith("family", project.publication, true);
  expect(f.call.mock.calls.map(call => call[2])).toEqual(["studio.plan", "studio.author", "studio.design", "studio.review"]);
});
it("blocks publication after a failed review and preserves the full candidate for correction", async () => {
  project = studioProjectFixture({ state: "generating", phase: "review", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: null }] });
  f.call.mockResolvedValue({ result: { verdict: "revise", issues: ["Уточнити приклад"], summary: "Потрібні виправлення" }, model: { provider: "openai", model: "test" }, costUsd: 0.01 });
  await step(); expect(project.state).toBe("needs_changes"); expect(project.units[0]!.content.title).toBe(studioLessonFixture.title);
  await expect(resumeStudio("family", id, project.revision, "publish")).rejects.toThrow(); expect(f.prepare).not.toHaveBeenCalled();
});
it("reserves before a paid call, retains the reserve on uncertainty, and never silently retries it", async () => {
  f.call.mockRejectedValue(new Error("provider failed"));
  await expect(step()).rejects.toThrow(); expect(project.activeCall).toBe(true); expect(project.heldUsd).toBeCloseTo(0.1);
  await expect(step()).rejects.toThrow("UNCERTAIN"); expect(f.call).toHaveBeenCalledTimes(1);
  await failStudioStep(job(), new Error("provider failed")); expect(project.state).toBe("failed");
  await resumeStudio("family", id, project.revision, "retry"); expect(project.heldUsd).toBeCloseTo(0.1); expect(project.activeCall).toBe(false);
});
it("refuses a project cap overrun, a stale revision and an obsolete worker token before any paid work", async () => {
  project.request.budgetUsd = 0.05;
  await expect(step()).rejects.toThrow("STUDIO-CAP"); expect(f.call).not.toHaveBeenCalled();
  project.state = "plan_ready"; project.plan = studioPlanFixture;
  await expect(resumeStudio("family", id, 999, "approve", studioPlanFixture)).rejects.toThrow();
  project.state = "planning";
  await runStudioStep({ ...job(), payload: { projectId: id, token: "old" } }, Date.now() + 220000); expect(f.call).not.toHaveBeenCalled();
});
it("rejects invented source references, a placeholder lesson and duplicated quiz options", () => {
  expect(() => validateStudioLesson(project, { ...studioLessonFixture, sourceIds: ["invented"] })).toThrow("SOURCE");
  expect(() => validateStudioLesson(project, { ...studioLessonFixture, blocks: studioLessonFixture.blocks.map(block => ({ ...block, text: "Короткий план" })) })).toThrow("INCOMPLETE");
  expect(() => validateStudioLesson(project, { ...studioLessonFixture, questions: studioLessonFixture.questions.map(question => ({ ...question, options: ["так", "так", "ні"] })) })).toThrow("DUPLICATE");
});

it("reuses an already-created request ID without another paid plan or project row", async () => {
  const request = structuredClone(project.request);
  expect(await startStudio("family", request, id)).toBe(id);
  expect(f.create).not.toHaveBeenCalled(); expect(f.sources).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
});
it("releases a reserve for a definite budget rejection before the provider was called", async () => {
  f.call.mockRejectedValue(new BudgetBlockedError("hard_stop", "studio.plan"));
  await expect(step()).rejects.toThrow(); expect(project.activeCall).toBe(false); expect(project.heldUsd).toBe(0); expect(project.spentUsd).toBe(0);
});
it("regenerates only the parent-selected lesson while preserving other passed lessons", async () => {
  const other = { content: { ...studioLessonFixture, title: "Другий готовий урок" }, visuals: [studioVisualFixture], review: { verdict: "pass" as const, issues: [], summary: "Пройдено" } };
  project = studioProjectFixture({ state: "ready", phase: "review", cursor: 1, plan: { ...studioPlanFixture, lessons: [...studioPlanFixture.lessons, { title: "Другий", goal: "Інша практика" }] }, units: [{ ...other, content: studioLessonFixture }, other] });
  await resumeStudio("family", id, 0, "revise", undefined, "Поясни простіше", undefined, 0);
  await step(); await step(); await step();
  expect(project.state).toBe("ready"); expect(project.units[1]!.content.title).toBe("Другий готовий урок"); expect(f.call).toHaveBeenCalledTimes(3);
});

it("pauses future stages, retains uncertain reserves and invalidates the old worker token", async () => {
  project = studioProjectFixture({ activeCall: true, heldUsd: 0.1 }); const oldJob = job();
  await pauseStudio("family", id, project.revision); expect(project.state).toBe("paused"); expect(project.heldUsd).toBe(0.1); expect(project.token).not.toBe(oldJob.payload.token);
  await runStudioStep(oldJob, Date.now() + 220000); expect(f.call).not.toHaveBeenCalled();
  await resumeStudio("family", id, project.revision, "retry"); expect(project.state).toBe("planning"); expect(project.heldUsd).toBe(0.1);
});
