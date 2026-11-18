vi.mock("./paid-result", () => {
  const receipts = new Map<string, unknown>();
  return { writeStudioPaidResult: vi.fn(async (_family: string, _project: string, pending: { id: string }, result: unknown) => { receipts.set(pending.id, structuredClone(result)); }), readStudioPaidResult: async (_family: string, _project: string, pending: { id: string }) => receipts.get(pending.id) ?? null };
});
import { BudgetBlockedError } from "@/server/ai/types";
import { beforeEach, expect, it, vi } from "vitest";
import type { StudioProject } from "@/lib/studio";
import { studioLessonFixture, studioPlanFixture, studioProjectFixture, studioVisualFixture } from "./__fixtures__/project";
const f = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), create: vi.fn(), enqueue: vi.fn(), call: vi.fn(), sources: vi.fn(), config: vi.fn(), prepare: vi.fn(), activate: vi.fn() }));
vi.mock("./store", () => ({ STUDIO_STEP: "studio.step", readStudioProject: f.read, saveStudioProject: f.save, createStudioProject: f.create }));
vi.mock("./review-history", () => ({ saveStudioReviewEvent: vi.fn() }));
vi.mock("./base-sources", () => ({ studioBaseCandidates: async () => ({topics:[],subjectName:null,fallbackMaterialId:null}), studioPreparedBaseSources: vi.fn() }));
vi.mock("./sources", async original => ({ ...await original<typeof import("./sources")>(), loadStudioSources: f.sources }));
vi.mock("./model", () => ({ studioModelConfig: f.config, studioReservation: () => 0.1, callStudioModel: f.call }));
vi.mock("./publish", () => ({ prepareStudioPublication: f.prepare, activateStudioPublication: f.activate }));
vi.mock("@/server/jobs/runner", () => ({ enqueueJob: f.enqueue, registerJobHandler: vi.fn() }));
import { writeStudioPaidResult } from "./paid-result";
import { saveStudioReviewEvent } from "./review-history";
import { resumeLegacyStudioReview, failStudioStep, pauseStudio, resumeStudio, runStudioStep, startStudio, validateStudioLesson } from "./workflow";
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
  await step(); expect(project.state).toBe("generating"); expect(project.phase).toBe("author"); expect(project.units[0]!.content.title).toBe(studioLessonFixture.title);
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
  expect(prompt.candidate.content.blocks).toEqual(content.blocks.map(block => ({ ...block, narration: block.kind === "code" ? block.narration : null })));
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
  expect(JSON.parse(f.call.mock.calls[0]![4]).candidate.content).toEqual({ ...studioLessonFixture, blocks: studioLessonFixture.blocks.map(block => ({ ...block, narration: block.kind === "code" ? block.narration : null })) });
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

it("automatically repairs and rechecks more than two times until pass, preserving parent instructions", async () => {
  project = studioProjectFixture({ state: "generating", phase: "review", plan: studioPlanFixture, revisionInstructions: "Додай приклад із Roblox", units: [{ content: studioLessonFixture, visuals: [], review: null }] });
  let reviews = 0;
  f.call.mockImplementation(async (_family, _id, role) => ({ result: role === "studio.author" ? { ...studioLessonFixture, title: `Виправлення ${reviews}` } : role === "studio.design" ? { visuals: [] } : ++reviews < 4 ? { verdict: "revise", issues: [`Уточнення ${reviews}`], corrections: [{ ...visualFix, role: "author", problem: `Уточнення ${reviews}` }], summary: "Виправити приклад" } : { verdict: "pass", issues: [], corrections: [], summary: "Пройдено" }, model: { provider: "openai", model: "test" }, costUsd: 0.01 }));
  for (let i = 0; i < 10; i++) await step();
  expect(project.state).toBe("ready"); expect(project.units[0]!.reviewRound).toBe(4); expect(f.enqueue).not.toHaveBeenCalled();
  for (const call of f.call.mock.calls.filter(call => call[2] === "studio.author")) expect(JSON.parse(call[4]).feedback).toContain("Додай приклад із Roblox");
});
it("routes visual-only review fixes automatically without rewriting lesson text", async () => {
  project = studioProjectFixture({ state: "generating", phase: "review", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [], review: null }] });
  f.call.mockResolvedValueOnce({ result: { verdict: "revise", issues: [visualFix.problem], corrections: [visualFix], summary: "Додати схему" }, model: { provider: "openai", model: "test" }, costUsd: 0.01 });
  await step(); expect(project.state).toBe("generating"); expect(project.phase).toBe("design"); await step(); await step(); expect(project.state).toBe("ready"); expect(f.call.mock.calls.map(call => call[2])).toEqual(["studio.review", "studio.design", "studio.review"]);
});
it("stops an identical candidate and identical failed review instead of silently burning the cap", async () => {
  project = studioProjectFixture({ state: "generating", phase: "review", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [], review: null }] });
  const review = { verdict: "revise", issues: [visualFix.problem], corrections: [visualFix], summary: "Додати схему" };
  f.call.mockImplementation(async (_family, _id, role) => ({ result: role === "studio.repair" ? { diagnosis: "Зміст залишився без змін після діагностики", reviewAdvice: "Перевір повторно", blocks: [], questions: [], visuals: null, title: null, objectives: null, sourceIds: null, enrichmentNote: null, adultAssistance: null } : role === "studio.design" ? { visuals: [] } : review, model: { provider: "openai", model: "test" }, costUsd: 0.01 }));
  await step(); await step(); await step(); expect(project.phase).toBe("repair"); expect(project.state).toBe("generating"); await step(); await step(); expect(project.state).toBe("needs_changes"); expect(project.reviewAutomationStopped).toBe(true); expect(project.error).toContain("NO-PROGRESS");
  await step(); expect(f.call).toHaveBeenCalledTimes(5);
});

it("automatically resumes an old waiting review once, without touching explicit stops or inventing a parent comment", async () => {
  project = studioProjectFixture({ state: "needs_changes", phase: "review", plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [], review: { verdict: "revise", issues: ["Виправити"], summary: "Потрібна правка" } }] });
  const before = project.token; await resumeLegacyStudioReview("family", id); expect(project.state).toBe("generating"); expect(project.token).not.toBe(before); expect(project.editorNotes).toBeUndefined(); expect(f.enqueue).toHaveBeenCalledOnce();
  await resumeLegacyStudioReview("family", id); expect(f.enqueue).toHaveBeenCalledOnce();
  for (const state of ["paused", "failed", "published", "needs_changes"] as const) { project.state = state; project.reviewAutomationStopped = true; await resumeLegacyStudioReview("family", id); expect(project.state).toBe(state); }
});

it("recovers a legacy no-progress stop into one diagnostic repair, without resetting its spend", async () => {
  project = studioProjectFixture({ state: "needs_changes", phase: "review", reviewAutomationStopped: true, error: "STUDIO-NO-PROGRESS: unchanged", spentUsd: 1.938, plan: studioPlanFixture, units: [{ content: studioLessonFixture, visuals: [], review: { verdict: "revise", issues: ["Виправити схему"], summary: "Потрібна правка" } }] });
  await resumeLegacyStudioReview("family", id);
  expect(project.phase).toBe("repair"); expect(project.reviewRepairAttempted).toBe(true); expect(project.spentUsd).toBe(1.938); expect(project.request.budgetUsd).toBe(3);
});
it("applies a diagnostic diagram replacement and reaches ready only after a new independent pass", async () => {
  const original = structuredClone(studioLessonFixture);
  project = studioProjectFixture({ state: "generating", phase: "repair", reviewRepairAttempted: true, plan: studioPlanFixture, units: [{ content: original, visuals: [studioVisualFixture], review: { verdict: "revise", issues: ["Обірвано крок"], summary: "Потрібна правка" } }] });
  const fixed = { ...studioVisualFixture, items: [{ label: "3. Якщо ні: чи використовують її як будівельну, хімічну або харчову сировину?", detail: "Так — це нерудна копалина" }, { label: "4. Поясни використання", detail: "Назви властивість і застосування" }] };
  f.call.mockResolvedValueOnce({ result: { diagnosis: "Крок схеми було обірвано попередньою межею підпису", reviewAdvice: "Перевір повне речення", blocks: [], questions: [], visuals: [fixed], title: null, objectives: null, sourceIds: null, enrichmentNote: null, adultAssistance: null }, model: { provider: "openai", model: "test" }, costUsd: 0.01 });
  await step(); expect(project.phase).toBe("review"); expect(project.state).toBe("generating"); expect(project.units[0]!.content).toEqual(original); expect(project.units[0]!.visuals).toEqual([fixed]);
  await step(); expect(project.state).toBe("ready"); expect(f.call.mock.calls.map(call => call[2])).toEqual(["studio.repair", "studio.review"]);
});
it("derives complete narration when the author returns null instead of a duplicate synopsis", () => {
 const raw=structuredClone(studioLessonFixture); const response={...raw,blocks:raw.blocks.map(block=>({...block,narration:block.kind==="code"?block.narration:null}))};
 const lesson=validateStudioLesson(project,response);expect(lesson.blocks[0]!.narration).toBe(lesson.blocks[0]!.text);expect(lesson.blocks[3]!.narration).toContain("початкову позицію");
});
it("reloads the complete selected document on explicit improvement without republishing the child version", async()=>{
 project=studioProjectFixture({state:"published",phase:"publish",plan:studioPlanFixture,request:{...studioProjectFixture().request,materialId:"book"},publication:{subjectId:"subject",packageId:"package",lessons:[]},units:[{content:studioLessonFixture,visuals:[],review:{verdict:"pass",issues:[],summary:"Добре"}}]});
 f.sources.mockResolvedValue({sources:[...project.sources,{id:"slide32",title:"Презентація",text:"Раніше пропущена тема",page:32,kind:"book"}],sourceNotes:["Увесь матеріал"],baseHref:null,baseTitle:null,subjectName:"Інформатика"});
 await resumeStudio("family",id,project.revision,"revise",undefined,"Повністю розкрий усі теми");expect(f.sources).toHaveBeenCalledOnce();expect(project.sources.some(source=>source.id==="slide32")).toBe(true);expect(project.publicationRevision).toBe(true);expect(f.prepare).not.toHaveBeenCalled();
});

it("sends the same nullable narration contract to author, designer, reviewer and repair while retaining full runtime speech", async () => {
 for (const phase of ["author","design","review","repair"] as const) {
  project=studioProjectFixture({state:"generating",phase,plan:studioPlanFixture,units:[{content:validateStudioLesson(studioProjectFixture(),studioLessonFixture),visuals:[],review:null}]});
  const storedNarration=project.units[0]!.content.blocks[0]!.narration;
  if(phase==="repair") f.call.mockResolvedValueOnce({result:{diagnosis:"Поточний матеріал відповідає контракту озвучення.",reviewAdvice:"Перевір за чинним контрактом",blocks:[],questions:[],visuals:null,title:null,objectives:null,sourceIds:null,enrichmentNote:null,adultAssistance:null},model:{provider:"openai",model:"test"},costUsd:0.02});
  await step();const prompt=JSON.parse(f.call.mock.calls.at(-1)![4]);
  expect(prompt.candidate.content.blocks[0].narration).toBeNull();expect(prompt.candidate.content.blocks[2].narration).toBe(studioLessonFixture.blocks[2]!.narration);
  expect(project.units[0]!.content.blocks[0]!.narration).toBe(storedNarration);expect(storedNarration.length).toBeGreaterThan(100);
 }
});
it("re-reviews a budget-stopped lesson without rewriting it, deleting uncertain reserves or publishing", async()=>{
 const content=validateStudioLesson(studioProjectFixture(),studioLessonFixture);
 project=studioProjectFixture({state:"failed",phase:"author",error:"STUDIO-CAP",plan:studioPlanFixture,spentUsd:1.512,heldUsd:1.057,units:[{content,visuals:[],review:{verdict:"revise",issues:["narration повинно бути null"],summary:"Застаріле зауваження"}}]});
 await resumeStudio("family",id,project.revision,"review");expect(project).toMatchObject({state:"generating",phase:"review",reviewOnly:true,spentUsd:1.512,heldUsd:1.057});
 await step();expect(project.state).toBe("ready");expect(project.units[0]!.content).toEqual(content);expect(project.heldUsd).toBeCloseTo(1.057);expect(project.spentUsd).toBeCloseTo(1.532);
 expect(f.call.mock.calls.map(call=>call[2])).toEqual(["studio.review"]);expect(f.prepare).not.toHaveBeenCalled();expect(f.activate).not.toHaveBeenCalled();
});
it("stops explicit re-review after substantive negative feedback instead of starting hidden paid revisions",async()=>{
 project=studioProjectFixture({state:"needs_changes",phase:"review",plan:studioPlanFixture,units:[{content:studioLessonFixture,visuals:[],review:null}]});
 f.call.mockResolvedValueOnce({result:{verdict:"revise",issues:["Помилка у прикладі"],summary:"Потрібне виправлення",corrections:[{role:"author",blockIndex:1,visualIndex:null,problem:"Помилка у прикладі",action:"Виправити приклад",acceptance:"Приклад узгоджений"}]},model:{provider:"openai",model:"test"},costUsd:0.02});
 await resumeStudio("family",id,project.revision,"review");await step();await step();
 expect(project).toMatchObject({state:"needs_changes",reviewOnly:true,reviewAutomationStopped:true});expect(project.units[0]!.review?.verdict).toBe("revise");expect(f.call).toHaveBeenCalledTimes(1);expect(f.prepare).not.toHaveBeenCalled();expect(saveStudioReviewEvent).toHaveBeenLastCalledWith("family",id,expect.any(String),expect.any(Number),expect.objectContaining({next:"parent"}));
 await resumeStudio("family",id,project.revision,"revise");expect(project.reviewOnly).toBe(false);expect(project.phase).toBe("author");
});
it("re-review of one course lesson does not automatically generate the remaining lessons",async()=>{
 project=studioProjectFixture({state:"paused",phase:"design",plan:{...studioPlanFixture,lessons:[...studioPlanFixture.lessons,{title:"Інша тема",goal:"Інший результат"}]},units:[{content:studioLessonFixture,visuals:[],review:null}]});
 await resumeStudio("family",id,project.revision,"review");await step();await step();
 expect(project).toMatchObject({state:"paused",cursor:1,phase:"author",reviewOnly:false});expect(f.call).toHaveBeenCalledTimes(1);expect(project.units[0]!.review?.verdict).toBe("pass");
});
it("refuses re-review with no saved lesson, a stale revision or interrupted publication",async()=>{
 project=studioProjectFixture({state:"failed"});await expect(resumeStudio("family",id,project.revision,"review")).rejects.toThrow();
 project=studioProjectFixture({state:"failed",phase:"publish",plan:studioPlanFixture,units:[{content:studioLessonFixture,visuals:[],review:null}]});await expect(resumeStudio("family",id,project.revision,"review")).rejects.toThrow();
 project.phase="review";await expect(resumeStudio("family",id,project.revision+1,"review")).rejects.toThrow();expect(f.call).not.toHaveBeenCalled();expect(f.enqueue).not.toHaveBeenCalled();
});
it("reports required and available project reserve without starting a call or discarding prior uncertain reservations",async()=>{
 project=studioProjectFixture({state:"generating",phase:"review",plan:studioPlanFixture,request:{...studioProjectFixture().request,budgetUsd:3},spentUsd:1.90,heldUsd:1.057,units:[{content:studioLessonFixture,visuals:[],review:null}]});
 const currentJob=job();let failure:unknown;try{await step();}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);await failStudioStep(currentJob,failure);
 expect(project.error).toContain("потрібен резерв $0.100");expect(project.error).toContain("доступно $0.043");expect(project.heldUsd).toBe(1.057);expect(project.spentUsd).toBe(1.90);expect(project.request.budgetUsd).toBe(3);expect(f.call).not.toHaveBeenCalled();
});

it("retains reviewer-only scope after an interrupted review is retried",async()=>{
 project=studioProjectFixture({state:"failed",phase:"review",reviewOnly:true,plan:studioPlanFixture,heldUsd:0.1,units:[{content:studioLessonFixture,visuals:[],review:null}]});
 f.call.mockResolvedValueOnce({result:{verdict:"revise",issues:["Неточне пояснення"],summary:"Потрібне виправлення",corrections:[{role:"author",blockIndex:0,visualIndex:null,problem:"Неточне пояснення",action:"Уточни визначення",acceptance:"Визначення правильне"}]},model:{provider:"openai",model:"test"},costUsd:0.02});
 await resumeStudio("family",id,project.revision,"retry");expect(project.reviewOnly).toBe(true);await step();await step();
 expect(project.state).toBe("needs_changes");expect(project.reviewAutomationStopped).toBe(true);expect(project.heldUsd).toBeCloseTo(0.1);expect(f.call).toHaveBeenCalledTimes(1);
});

it("retains a paid invalid response and revalidates it without another provider call, reserve, or cost",async()=>{
 project=studioProjectFixture({state:"generating",phase:"author",plan:studioPlanFixture,units:[]});
 f.call.mockResolvedValueOnce({result:{...studioLessonFixture,blocks:studioLessonFixture.blocks.map(block=>({...block,text:"Короткий текст"}))},model:{provider:"openai",model:"test"},costUsd:0.02});
 await step();expect(project.state).toBe("failed");expect(project.pendingModelCall?.billed).toBe(true);expect(project.failureDiagnostic?.code).toBe("STUDIO-INCOMPLETE-LESSON");expect(project.spentUsd).toBeCloseTo(0.02);expect(project.heldUsd).toBe(0);
 await resumeStudio("family",id,project.revision,"retry",undefined,"",5);await step();
 expect(f.call).toHaveBeenCalledTimes(1);expect(f.config).toHaveBeenCalledTimes(1);expect(project.spentUsd).toBeCloseTo(0.02);expect(project.models).toHaveLength(1);expect(project.state).toBe("failed");
 await resumeStudio("family",id,project.revision,"regenerate");await step();
 expect(f.call).toHaveBeenCalledTimes(2);const input=JSON.parse(f.call.mock.calls[1]![4]);expect(input.validationRepair.diagnostic.code).toBe("STUDIO-INCOMPLETE-LESSON");expect(input.validationRepair.rejectedResult.blocks[0].text).toBe("Короткий текст");expect(project.phase).toBe("design");expect(project.pendingModelCall).toBeUndefined();expect(project.spentUsd).toBeCloseTo(0.04);
});
it("reapplies a valid paid reviewer result after a transient history-storage error without paying again",async()=>{
 project=studioProjectFixture({state:"generating",phase:"review",plan:studioPlanFixture,units:[{content:studioLessonFixture,visuals:[],review:null}]});
 vi.mocked(saveStudioReviewEvent).mockRejectedValueOnce(new Error("db temporarily unavailable"));await step();
 expect(project.failureDiagnostic?.category).toBe("processing");expect(project.pendingModelCall?.billed).toBe(true);expect(project.units[0]!.review).toBeNull();
 await resumeStudio("family",id,project.revision,"retry");await step();expect(project.state).toBe("ready");expect(project.spentUsd).toBeCloseTo(0.02);expect(project.models).toHaveLength(1);expect(f.call).toHaveBeenCalledTimes(1);expect(f.config).toHaveBeenCalledTimes(1);
 const events=vi.mocked(saveStudioReviewEvent).mock.calls;expect(events.at(-1)![2]).toBe(events.at(-2)![2]);expect(events.at(-1)![3]).toBe(0);
});
it("reconciles an ambiguously successful receipt write exactly once on explicit retry",async()=>{
 const original=vi.mocked(writeStudioPaidResult).getMockImplementation()!;
 vi.mocked(writeStudioPaidResult).mockImplementationOnce(async(...args)=>{await original(...args);throw Error("write acknowledgement lost");});
 const current=job();let failure:unknown;try{await step();}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);expect(project.pendingModelCall?.billed).toBe(false);expect(project.heldUsd).toBeCloseTo(0.1);expect(project.spentUsd).toBe(0);await failStudioStep(current,failure);
 await resumeStudio("family",id,project.revision,"retry");await step();expect(project.state).toBe("plan_ready");expect(project.spentUsd).toBeCloseTo(0.02);expect(project.heldUsd).toBe(0);expect(project.models).toHaveLength(1);expect(f.call).toHaveBeenCalledTimes(1);
});
it("never replays a saved paid response into a changed educational context",async()=>{
 project=studioProjectFixture({state:"generating",phase:"author",plan:studioPlanFixture});f.call.mockResolvedValueOnce({result:{...studioLessonFixture,blocks:studioLessonFixture.blocks.map(block=>({...block,text:"Коротко"}))},model:{provider:"openai",model:"test"},costUsd:0.02});await step();
 project.request={...project.request,idea:"Інша мета й інший зміст уроку"};await resumeStudio("family",id,project.revision,"retry");await expect(step()).rejects.toThrow("RESULT-CONTEXT");expect(f.call).toHaveBeenCalledTimes(1);expect(project.spentUsd).toBeCloseTo(0.02);
});
it("keeps a late paid result across a pause and settles it only when the parent resumes",async()=>{
 let resolve!: (value:{result:typeof studioPlanFixture;model:{provider:string;model:string};costUsd:number})=>void;
 f.call.mockImplementationOnce(()=>new Promise(value=>{resolve=value;}));const old=job();const running=runStudioStep(old,Date.now()+220000);await vi.waitFor(()=>expect(f.call).toHaveBeenCalledTimes(1));
 await pauseStudio("family",id,project.revision);resolve({result:studioPlanFixture,model:{provider:"openai",model:"test"},costUsd:0.02});await expect(running).rejects.toThrow("stale");expect(project.state).toBe("paused");expect(project.spentUsd).toBe(0);expect(project.heldUsd).toBeCloseTo(0.1);
 await resumeStudio("family",id,project.revision,"retry");await step();expect(project.state).toBe("plan_ready");expect(project.spentUsd).toBeCloseTo(0.02);expect(project.heldUsd).toBe(0);expect(f.call).toHaveBeenCalledTimes(1);
});
it("blocks context-changing review commands while an unsettled author call is pending",async()=>{
 project=studioProjectFixture({state:"paused",phase:"author",plan:studioPlanFixture,units:[{content:studioLessonFixture,visuals:[],review:null}],pendingModelCall:{id:"11111111-1111-4111-8111-111111111112",phase:"author",cursor:0,inputHash:"a".repeat(64),reservedUsd:0.1,billed:false},heldUsd:0.1});
 await expect(resumeStudio("family",id,project.revision,"review")).rejects.toThrow("контекст");expect(project.phase).toBe("author");expect(project.pendingModelCall?.billed).toBe(false);expect(project.heldUsd).toBe(0.1);expect(f.enqueue).not.toHaveBeenCalled();expect(f.call).not.toHaveBeenCalled();
});

it("preserves learner context while a saved call awaits processing",async()=>{
 project=studioProjectFixture({state:"paused",pendingModelCall:{id:"11111111-1111-4111-8111-111111111112",phase:"plan",cursor:0,inputHash:"a".repeat(64),reservedUsd:0.1,billed:true}});
 await expect(resumeStudio("family",id,project.revision,"retry",undefined,"",5,undefined,undefined,{age:project.request.age+1,grade:project.request.grade})).rejects.toThrow("вік і клас");expect(f.enqueue).not.toHaveBeenCalled();expect(f.call).not.toHaveBeenCalled();
});

it("accounts and retains an incomplete paid response without applying or silently regenerating it",async()=>{
 f.call.mockResolvedValueOnce({result:'{"title":',failure:{code:"STUDIO-AI-INCOMPLETE",paths:[]},model:{provider:"openai",model:"test"},costUsd:0.023});await step();
 expect(project.state).toBe("failed");expect(project.failureDiagnostic?.code).toBe("STUDIO-AI-INCOMPLETE");expect(project.spentUsd).toBeCloseTo(0.023);expect(project.heldUsd).toBe(0);expect(project.pendingModelCall?.billed).toBe(true);expect(project.plan).toBeNull();
 await resumeStudio("family",id,project.revision,"retry");await step();expect(f.call).toHaveBeenCalledTimes(1);expect(project.spentUsd).toBeCloseTo(0.023);expect(project.models).toHaveLength(1);expect(project.state).toBe("failed");
});
it("makes uncertain-response verification free and requires explicit paid restart while retaining the old reserve",async()=>{
 const {ProviderError}=await import("@/server/ai/types");f.call.mockRejectedValueOnce(new ProviderError("private timeout", "openai", null, true, "timeout"));const oldJob=job();let failure:unknown;try{await step();}catch(error){failure=error;}await failStudioStep(oldJob,failure);
 expect(project.failureDiagnostic?.code).toBe("STUDIO-AI-TIMEOUT");expect(project.error).not.toContain("private timeout");expect(project.heldUsd).toBeCloseTo(0.1);
 f.enqueue.mockClear();await resumeStudio("family",id,project.revision,"retry");expect(project.state).toBe("failed");expect(project.failureDiagnostic?.code).toBe("STUDIO-AI-TIMEOUT");expect(f.enqueue).not.toHaveBeenCalled();expect(f.call).toHaveBeenCalledTimes(1);
 const pending=project.pendingModelCall;await resumeStudio("family",id,project.revision,"restart");await step();expect(project.unresolvedModelCalls).toContainEqual(pending);expect(project.heldUsd).toBeCloseTo(0.1);expect(project.spentUsd).toBeCloseTo(0.02);expect(project.state).toBe("plan_ready");expect(f.call).toHaveBeenCalledTimes(2);
});
it("releases only the current reserve for a definitive rejected request, retaining older uncertain holds",async()=>{
 const {ProviderError}=await import("@/server/ai/types");project.heldUsd=0.7;f.call.mockRejectedValueOnce(new ProviderError("provider secret", "openai", 400, false, "invalid_schema"));const oldJob=job();let failure:unknown;try{await step();}catch(error){failure=error;}await failStudioStep(oldJob,failure);
 expect(project.heldUsd).toBeCloseTo(0.7);expect(project.pendingModelCall).toBeUndefined();expect(project.spentUsd).toBe(0);expect(project.failureDiagnostic).toMatchObject({code:"STUDIO-AI-REQUEST-SCHEMA",provider:"openai",status:400});
});

it("backs off once per unchanged request after a provider rate limit", async () => {
 const {ProviderError}=await import("@/server/ai/types");
 f.call.mockRejectedValue(new ProviderError("rate limited","openai",429,true));
 expect(await step()).toEqual({requeue:true,delaySeconds:30});
 expect(project.heldUsd).toBe(0);
 await expect(step()).rejects.toMatchObject({status:429});
 expect(f.call).toHaveBeenCalledTimes(2);
 expect(project.spentUsd).toBe(0);
});
it("hands authoring to a fresh worker before reserving when time is short", async () => {
  project = studioProjectFixture({ phase: "author", state: "generating", plan: studioPlanFixture });
  f.config.mockResolvedValue({ route: { params: { max_tokens: 16000, timeout_ms: 210000 } }, rates: {} });
  expect(await runStudioStep(job(), Date.now() + 180000)).toMatchObject({ requeue: true });
  expect(f.call).not.toHaveBeenCalled();
  expect(project.heldUsd).toBe(0);
  await runStudioStep(job(), Date.now() + 255000);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(project.phase).toBe("design");
});
