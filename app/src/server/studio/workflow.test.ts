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
  f.call.mockImplementation(async (_family, _id, role) => ({ result: role === "studio.plan" ? studioPlanFixture : role === "studio.author" ? studioLessonFixture : role === "studio.design" ? { visuals: [studioVisualFixture] } : { verdict: "pass", issues: [], corrections: [], summary: "Зміст і схема узгоджені." }, model: { provider: "openai", model: "test-model" }, costUsd: 0.02 }));
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
  f.call.mockResolvedValue({ result: { verdict: "revise", issues: ["Уточнити приклад"], corrections: [{ role: "author", blockIndex: 1, visualIndex: null, problem: "Нечіткий приклад", action: "Уточни значення Y перед переміщенням", acceptance: "Вказане початкове значення Y" }], summary: "Потрібні виправлення" }, model: { provider: "openai", model: "test" }, costUsd: 0.01 });
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

const visualFix = { role: "design" as const, blockIndex: 1, visualIndex: null, problem: "Відсутня обіцяна схема публікацій", action: "Додай comparison «Що можна / не можна публікувати» з двома items: загальні інтереси; паролі не публікувати", acceptance: "Три обіцяні схеми представлені, comparison має null width/height і порожній unit" };
it("repairs a third diagram without rewriting approved content and accepts null physical dimensions", async () => {
  const content = structuredClone(studioLessonFixture);
  const visuals = [studioVisualFixture, { ...studioVisualFixture, blockIndex: 1, title: "Кібербулінг" }];
  project = studioProjectFixture({ state: "needs_changes", phase: "review", plan: studioPlanFixture, units: [{ content, visuals, review: { verdict: "revise", issues: [visualFix.problem], corrections: [visualFix], summary: "Зміст правильний, бракує схеми" } }] });
  await resumeStudio("family", id, project.revision, "revise");
  expect(project.phase).toBe("design");
  f.call.mockResolvedValueOnce({ result: { visuals: [...visuals, { ...studioVisualFixture, blockIndex: 1, title: "Що можна / не можна публікувати" }] }, model: { provider: "openai", model: "test" }, costUsd: 0.01 });
  await step();
  const prompt = JSON.parse(f.call.mock.calls[0]![4]);
  expect(prompt.candidate.visuals).toEqual(visuals);
  expect(prompt.candidate.content.blocks).toEqual(content.blocks);
  expect(prompt.candidate.content.questions).toBeUndefined();
  expect(prompt.feedback).toContain(visualFix.acceptance);
  expect(project.units[0]!.content).toEqual(content);
  expect(project.units[0]!.visuals).toHaveLength(3);
  await step(); expect(project.state).toBe("ready");
  expect(f.call.mock.calls.map(call => call[2])).toEqual(["studio.design", "studio.review"]);
});
it("gives authors the existing lesson and preserves previous visuals for the designer", async () => {
  project = studioProjectFixture({ state: "needs_changes", phase: "review", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: { verdict: "revise", issues: ["Позначити інтерпретацію емоджі"], summary: "Уточнити приклад" } }] });
  await resumeStudio("family", id, project.revision, "revise", undefined, "Не змінюй решту");
  await step();
  expect(JSON.parse(f.call.mock.calls[0]![4]).candidate.content).toEqual(studioLessonFixture);
  expect(project.units[0]!.visuals).toEqual([studioVisualFixture]);
  await step(); expect(JSON.parse(f.call.mock.calls[1]![4]).candidate.visuals).toEqual([studioVisualFixture]);
});
it("rejects non-actionable reviews and out-of-range correction targets without approving publication", async () => {
  for (const corrections of [[], [{ ...visualFix, visualIndex: 5 }]]) {
    project = studioProjectFixture({ state: "generating", phase: "review", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: null }] });
    f.call.mockResolvedValueOnce({ result: { verdict: "revise", issues: ["Потрібні зміни"], corrections, summary: "Зміни" }, model: { provider: "openai", model: "test" }, costUsd: 0.01 });
    await step(); expect(project.state).toBe("failed"); expect(project.units[0]!.review).toBeNull();
  }
});

it("revises a published lesson as a draft and republishes through persistence instead of just reactivating old content", async () => {
  const publication = { subjectId: "existing", packageId: "same-package", lessons: [{ id: "same-lesson", topicId: "same-topic", title: "Координати" }] };
  project = studioProjectFixture({ state: "published", phase: "publish", plan: studioPlanFixture, publication, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: { verdict: "pass", issues: [], summary: "Пройдено" } }] });
  await expect(resumeStudio("family", id, project.revision, "revise")).rejects.toThrow("Опиши");
  await resumeStudio("family", id, project.revision, "revise", undefined, "Виправ таблицю у блоці 2");
  expect(project.publicationRevision).toBe(true); expect(project.publication).toEqual(publication); expect(f.prepare).not.toHaveBeenCalled();
  await step(); await step(); await step(); expect(project.state).toBe("ready");
  f.prepare.mockResolvedValue(publication);
  await resumeStudio("family", id, project.revision, "publish"); await step();
  expect(f.prepare).toHaveBeenCalled(); expect(f.activate).toHaveBeenCalledWith("family", publication, true);
  expect(project.state).toBe("published"); expect(project.publicationRevision).toBe(false); expect(project.publication).toEqual(publication);
});

it("lets a hidden publication be revised without making its old version visible", async () => {
  project = studioProjectFixture({ state: "withdrawn", phase: "publish", plan: studioPlanFixture, publication: { subjectId: "subject", packageId: "package", lessons: [] }, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: { verdict: "pass", issues: [], summary: "Пройдено" } }] });
  await resumeStudio("family", id, project.revision, "revise", undefined, "Уточни приклад");
  expect(project.state).toBe("generating"); expect(project.childAccess).toBe("disabled"); expect(project.publicationRevision).toBe(true); expect(project.editorNotes?.at(-1)?.text).toBe("Уточни приклад");
});
it("requires native listening examples while retaining Ukrainian explanation in language lessons", () => {
  const languageProject = { ...project, request: { ...project.request, targetLanguage: "en" as const } };
  expect(() => validateStudioLesson(languageProject, studioLessonFixture)).toThrow("STUDIO-LANGUAGE-CONTENT");
  const lesson = structuredClone(studioLessonFixture); lesson.blocks.find(block => block.kind === "example")!.narrationLanguage = "en-GB"; lesson.blocks.find(block => block.kind === "example")!.narration = "Hello! My name is Alex. How are you?";
  expect(validateStudioLesson(languageProject, lesson).blocks.some(block => block.narrationLanguage === "en-GB")).toBe(true);
  lesson.blocks.find(block => block.kind === "example")!.narrationLanguage = "de-DE";
  expect(() => validateStudioLesson(languageProject, lesson)).toThrow();
});
it("checkpoints a 24-lesson outline in four bounded batches, with no six-lesson course ceiling", async () => {
  project.request.lessonCount = 24; project.request.budgetUsd = 20;
  f.call.mockImplementation(async (_family, _id, _role, _system, prompt) => {
    const input = JSON.parse(prompt); const batch = input.planningBatch;
    return { result: { ...studioPlanFixture, lessons: Array.from({ length: batch.count }, (_, index) => ({ title: `Урок ${batch.startLesson + index}`, goal: `Результат ${batch.startLesson + index}` })) }, model: { provider: "openai", model: "test" }, costUsd: 0.02 };
  });
  await step(); expect(project.state).toBe("planning"); expect(project.plan!.lessons).toHaveLength(6);
  await step(); expect(project.plan!.lessons).toHaveLength(12);
  await step(); await step(); expect(project.state).toBe("plan_ready"); expect(project.plan!.lessons).toHaveLength(24);
  expect(f.call.mock.calls.map(call => JSON.parse(call[4]).planningBatch.startLesson)).toEqual([1,7,13,19]);
  await resumeStudio("family", id, project.revision, "approve", project.plan!); expect(project.state).toBe("generating");
});
it("resumes a partial outline without discarding completed batches or increasing the budget", async () => {
  project.request.lessonCount = 8; project.plan = { ...studioPlanFixture, lessons: Array.from({ length: 6 }, (_, i) => ({ title: `Крок ${i + 1}`, goal: "Ціль" })) };
  project.state = "paused"; const budget = project.request.budgetUsd;
  f.call.mockResolvedValue({ result: { ...studioPlanFixture, lessons: [{ title: "Крок 7", goal: "Ціль" }, { title: "Крок 8", goal: "Ціль" }] }, model: { provider: "openai", model: "test" }, costUsd: 0.02 });
  await resumeStudio("family", id, project.revision, "retry"); await step(); expect(project.plan!.lessons.map(lesson=>lesson.title)).toContain("Крок 1"); expect(project.state).toBe("plan_ready"); expect(project.request.budgetUsd).toBe(budget);
});
it("rejects written-response knowledge checks but keeps code examples and optional off-app practice", () => {
  const lesson = structuredClone(studioLessonFixture); lesson.questions[0]!.prompt = "Напиши розгорнуту відповідь про координати.";
  expect(() => validateStudioLesson(project, lesson)).toThrow("STUDIO-TOUCH-QUIZ");
  const practice = structuredClone(studioLessonFixture); practice.blocks[3]!.text = "Введи свою відповідь у текстове поле. " + practice.blocks[3]!.text;
  practice.blocks[3]!.text = practice.blocks[3]!.text.replace("За бажанням", "Завдання");
  expect(() => validateStudioLesson(project, practice)).toThrow("STUDIO-TYPING-ASSESSMENT");
  expect(() => validateStudioLesson(project, studioLessonFixture)).not.toThrow();
});
