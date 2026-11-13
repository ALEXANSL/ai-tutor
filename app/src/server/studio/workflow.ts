import "server-only";
import { AiNotConfiguredError, BudgetBlockedError } from "@/server/ai/types";
import { randomUUID } from "node:crypto";
import { studioDesignSchema, studioLessonSchema, studioPlanSchema, studioReviewResponseSchema, studioActive, studioPublicationVisible, type StudioPlan, type StudioProject, type StudioRequest } from "@/lib/studio";
import { enqueueJob, registerJobHandler, type JobRow } from "@/server/jobs/runner";
import { forFamily } from "@/server/db/family-scope";
import { loadStudioSources } from "./sources";
import { createStudioProject, readStudioProject, saveStudioProject, STUDIO_STEP } from "./store";
import { callStudioModel, studioModelConfig, studioReservation, type StudioRole } from "./model";
import { studioSystem } from "./prompts";
import { activateStudioPublication, prepareStudioPublication } from "./publish";

function studioReviewFeedback(review: import("@/lib/studio").StudioReview | null | undefined): string {
  if (!review) return "";
  return JSON.stringify({ summary: review.summary, issues: review.issues, corrections: review.corrections ?? [], instruction: "Виправ перелічене у попередньому candidate. Збережи коректні частини. Старі зауваження перевір заново за чинним контрактом; не виконуй вимоги, що суперечать йому." });
}

export async function scheduleStudio(familyId: string, id: string, token: string) {
  await enqueueJob(familyId, STUDIO_STEP, { projectId: id, token }, { dedupeKey: `studio:${id}:${token}`, maxAttempts: 1 });
}
export async function startStudio(familyId: string, request: StudioRequest, requestId: string, revisionRequestId?: string): Promise<string> {
  const existing = await readStudioProject(familyId, requestId);
  if (existing) { if (JSON.stringify(existing.request) !== JSON.stringify(request)) throw new Error("Ця чернетка вже має інший запит. Створи нову з оновленими полями."); return requestId; }
  const source = await loadStudioSources(familyId, request);
  const project: StudioProject = { ...(revisionRequestId ? { revisionRequestId } : {}), version: 1, revision: 0, request, ...source, createdAt: new Date().toISOString(), state: "planning", phase: "plan", plan: null, units: [], cursor: 0, token: randomUUID(), activeCall: false, spentUsd: 0, heldUsd: 0, feedback: "", error: null, models: [], publication: null };
  const id = await createStudioProject(familyId, project, requestId);
  const saved = await readStudioProject(familyId, id);
  if (saved?.token !== project.token) return id;
  try { await scheduleStudio(familyId, id, project.token); }
  catch { await saveStudioProject(familyId, id, project, { state: "failed", error: "Не вдалося поставити план у чергу. Чернетку збережено; можна повторити." }); }
  return id;
}
export function validateStudioLesson(project: StudioProject, raw: unknown) {
  const lesson = studioLessonSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(lesson)) > 70000) throw new Error("STUDIO-LESSON-SIZE");
  const ids = new Set(project.sources.map(source => source.id));
  if (lesson.sourceIds.some(id => !ids.has(id))) throw new Error("STUDIO-SOURCE-REF");
  if (lesson.blocks.reduce((sum, block) => sum + block.text.length, 0) < 1800 || !lesson.blocks.some(block => block.kind === "explanation") || !lesson.blocks.some(block => block.kind === "example") || !lesson.blocks.some(block => ["practice", "steps"].includes(block.kind))) throw new Error("STUDIO-INCOMPLETE-LESSON");
  if (lesson.questions.some(question => new Set(question.options.map(option => option.toLocaleLowerCase("uk").trim())).size !== 3)) throw new Error("STUDIO-DUPLICATE-OPTIONS");
  if (project.request.targetLanguage) {
    const language = project.request.targetLanguage === "en" ? "en-GB" : "de-DE";
    if (!lesson.blocks.some(block => block.narrationLanguage === language) || !lesson.blocks.some(block => block.kind === "explanation" && /[А-Яа-яІіЇїЄєҐґ]/u.test(block.narration))) throw new Error("STUDIO-LANGUAGE-CONTENT");
    if (lesson.blocks.some(block => block.narrationLanguage === language && (/[\p{Script=Cyrillic}]/u.test(block.narration) || !/[\p{Script=Latin}]/u.test(block.narration)))) throw new Error("STUDIO-NATIVE-NARRATION");
    if (lesson.blocks.some(block => block.narrationLanguage && !["uk-UA", language].includes(block.narrationLanguage))) throw new Error("STUDIO-LANGUAGE-MISMATCH");
  }
  return lesson;
}
function safeStageError(error: unknown): string {
  const name = (error as Error)?.name;
  if (name === "BudgetBlockedError") return "STUDIO-BUDGET: загальний ліміт ШІ призупинив підготовку. Перевір «Бюджет і моделі».";
  if (name === "AiNotConfiguredError") return "STUDIO-CONFIG: перевір OpenAI та налаштування моделей майстерні у «Бюджет і моделі».";
  if (error instanceof Error && error.message === "STUDIO-CONTEXT") return "STUDIO-CONTEXT: джерела та результат цього етапу завеликі. Підготуй коротшу частину в новій чернетці або звузь джерела; готові частини тут збережено.";
  if (error instanceof Error && error.message.startsWith("STUDIO-CAP")) return "STUDIO-CAP: наступний виклик перевищив би бюджет проєкту. Збільш ліміт або скороти матеріали; уже готові частини збережено.";
  return "STUDIO-STAGE: етап не завершено. Уже готові матеріали збережено. Перевір бюджет і повтори потрібний етап; невизначений платний виклик залишається в резерві.";
}
export async function runStudioStep(job: JobRow, deadline: number) {
  const id = String(job.payload.projectId ?? ""), token = String(job.payload.token ?? "");
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid studio project");
  let project = await readStudioProject(job.family_id, id);
  if (!project || project.token !== token || !studioActive(project.state)) return;
  if (project.activeCall) throw new Error("STUDIO-UNCERTAIN-CALL");
  if (deadline - Date.now() < 145000) return { requeue: true as const, delaySeconds: 10 };
  if (project.phase === "publish") {
    const publication = project.publicationRevision ? await prepareStudioPublication(job.family_id, id, project) : project.publication ?? await prepareStudioPublication(job.family_id, id, project);
    project = await saveStudioProject(job.family_id, id, project, { publication });
    await activateStudioPublication(job.family_id, publication, !project.request.subjectId);
    await saveStudioProject(job.family_id, id, project, { state: "published", publicationRevision: false, childAccess: "enabled", error: null }); return;
  }
  const role: StudioRole = project.phase === "plan" ? "studio.plan" : project.phase === "author" ? "studio.author" : project.phase === "design" ? "studio.design" : "studio.review";
  const schema = project.phase === "plan" ? studioPlanSchema : project.phase === "author" ? studioLessonSchema : project.phase === "design" ? studioDesignSchema : studioReviewResponseSchema;
  const system = studioSystem(role);
  const prompt = JSON.stringify({ request: { ...project.request, sourceText: undefined, subjectId: undefined, topicId: undefined, materialId: undefined }, subject: project.subjectName, baseTitle: project.baseTitle, plan: project.plan, currentLesson: project.plan?.lessons[project.cursor] ?? null, sources: project.sources, sourceNotes: project.sourceNotes, feedback: project.feedback, ...(project.units[project.cursor] ? { candidate: { content: project.phase === "design" ? { title: project.units[project.cursor]!.content.title, objectives: project.units[project.cursor]!.content.objectives, blocks: project.units[project.cursor]!.content.blocks } : project.units[project.cursor]!.content, visuals: project.units[project.cursor]!.visuals } } : {}) });
  if (Buffer.byteLength(system + prompt + JSON.stringify(schema.toJSONSchema())) > 250000) throw new Error("STUDIO-CONTEXT");
  const config = await studioModelConfig(job.family_id, role);
  const reserved = studioReservation(system, prompt, schema, config.route.params.max_tokens!, config.rates);
  if (project.spentUsd + project.heldUsd + reserved > project.request.budgetUsd) throw new Error("STUDIO-CAP");
  project = await saveStudioProject(job.family_id, id, project, { activeCall: true, heldUsd: project.heldUsd + reserved });
  let result;
  try { result = await callStudioModel(job.family_id, id, role, system, prompt, schema, config); }
  catch (error) {
    if (error instanceof AiNotConfiguredError || error instanceof BudgetBlockedError) await saveStudioProject(job.family_id, id, project, { activeCall: false, heldUsd: Math.max(0, project.heldUsd - reserved) });
    throw error;
  }
  const changes: Partial<StudioProject> = { activeCall: false, heldUsd: Math.max(0, project.heldUsd - reserved), spentUsd: project.spentUsd + result.costUsd, models: [...project.models, { role, model: `${result.model.provider}/${result.model.model}`, costUsd: result.costUsd }] };
  try {
  if (project.phase === "plan") {
    const plan = studioPlanSchema.parse(result.result);
    if (plan.lessons.length !== project.request.lessonCount) throw new Error("STUDIO-PLAN-COUNT");
    Object.assign(changes, { plan, state: "plan_ready" });
  } else {
    const units = [...project.units];
    if (project.phase === "author") {
      units[project.cursor] = { content: validateStudioLesson(project, result.result), visuals: units[project.cursor]?.visuals ?? [], review: null }; changes.phase = "design";
    } else if (project.phase === "design") {
      const { visuals } = studioDesignSchema.parse(result.result);
      if (visuals.some(visual => visual.blockIndex >= units[project.cursor]!.content.blocks.length || (visual.kind === "dimensions" && (!visual.width || !visual.height || !visual.unit)))) throw new Error("STUDIO-VISUAL-REF");
      units[project.cursor] = { ...units[project.cursor]!, visuals }; changes.phase = "review";
    } else {
      const review = studioReviewResponseSchema.parse(result.result);
      if (review.corrections.some(fix => (fix.blockIndex !== null && fix.blockIndex >= units[project.cursor]!.content.blocks.length) || (fix.visualIndex !== null && fix.visualIndex >= units[project.cursor]!.visuals.length))) throw new Error("STUDIO-CORRECTION-REF");
      if (review.verdict !== "pass" && (!review.corrections.length || review.corrections.length !== review.issues.length)) throw new Error("STUDIO-CORRECTION-MISSING");
      if (review.verdict === "pass" && (review.issues.length || review.corrections.length)) throw new Error("STUDIO-REVIEW-CONFLICT");
      units[project.cursor] = { ...units[project.cursor]!, review };
      if (review.verdict !== "pass") Object.assign(changes, { state: "needs_changes", feedback: studioReviewFeedback(review) });
      else {
        const next = project.plan!.lessons.findIndex((_lesson, index) => units[index]?.review?.verdict !== "pass");
        if (next < 0) changes.state = "ready";
        else Object.assign(changes, { cursor: next, phase: "author", feedback: "" });
      }
    }
    changes.units = units;
  }
  } catch {
    await saveStudioProject(job.family_id, id, project, { ...changes, activeCall: false, state: "failed", error: "STUDIO-CONTENT: результат не пройшов перевірку повноти, джерел або структури. Оплачений виклик враховано; попередні частини збережено. Повтори цей етап." }); return;
  }
  const next = await saveStudioProject(job.family_id, id, project, changes);
  if (studioActive(next.state)) return { requeue: true as const };
}
export async function resumeStudio(familyId: string, id: string, revision: number, command: "approve" | "retry" | "revise" | "publish", plan?: StudioPlan, feedback = "", budgetUsd?: number, lessonIndex?: number, revisionRequestId?: string, learner?: { age: number; grade: number }) {
  const project = await readStudioProject(familyId, id);
  if (!project || project.revision !== revision || studioActive(project.state) || (["published", "withdrawn"].includes(project.state) && command !== "revise")) throw new Error("Онови чернетку перед дією.");
  const token = randomUUID();
  let changes: Partial<StudioProject> = { ...(revisionRequestId ? { revisionRequestId } : {}), token, activeCall: false, error: null };
  if (budgetUsd !== undefined) changes.request = { ...project.request, budgetUsd };
  if (learner) changes.request = { ...(changes.request ?? project.request), age: learner.age, grade: learner.grade };
  if (command === "approve") {
    if (project.state !== "plan_ready" || !plan || plan.lessons.length !== project.request.lessonCount) throw new Error("Перевір план та кількість уроків.");
    changes = { ...changes, plan, state: "generating", phase: "author", cursor: 0, units: [] };
  } else if (command === "publish") {
    if (project.state !== "ready" || project.units.length !== project.plan?.lessons.length || project.units.some(unit => unit.review?.verdict !== "pass")) throw new Error("Спочатку потрібні готові уроки й позитивна рецензія.");
    changes = { ...changes, state: "publishing", phase: "publish" };
  } else if (command === "revise") {
    const cursor = lessonIndex ?? project.cursor;
    if (!["needs_changes", "ready", "published", "withdrawn"].includes(project.state) || !Number.isSafeInteger(cursor) || !project.units[cursor]) throw new Error("Немає уроку для виправлення.");
    if (["published", "withdrawn"].includes(project.state) && !feedback.trim()) throw new Error("Опиши, що потрібно виправити в опублікованому уроці.");
    const review = project.units[cursor]!.review;
    // Only structured, exclusively visual corrections can skip authoring. Legacy reviews
    // and parent instructions still receive a full, contextual revision.
    const designOnly = !feedback.trim() && review?.corrections?.length && review.corrections.every(fix => fix.role === "design");
    changes = { ...changes, state: "generating", publicationRevision: project.publicationRevision || !!project.publication, childAccess: studioPublicationVisible(project) ? "enabled" : "disabled", editorNotes: [...(project.editorNotes ?? []), { at: new Date().toISOString(), lessonIndex: cursor, text: feedback.trim() || "Виправити зауваження рецензента" }].slice(-30), phase: designOnly ? "design" : "author", cursor, feedback: `${studioReviewFeedback(review)}\nПобажання тата: ${feedback}` };
  } else {
    if (!["failed", "paused"].includes(project.state)) throw new Error("Продовження доступне після паузи або збою етапу.");
    changes.state = project.phase === "plan" ? "planning" : project.phase === "publish" ? "publishing" : "generating";
  }
  const next = await saveStudioProject(familyId, id, project, changes);
  try { await scheduleStudio(familyId, id, token); }
  catch { await saveStudioProject(familyId, id, next, { state: "failed", error: "Чернетку збережено, але черга недоступна. Повтори етап пізніше." }); }
}
export async function pauseStudio(familyId: string, id: string, revision: number) {
  const project = await readStudioProject(familyId, id);
  if (!project || revision > project.revision || !["planning", "generating"].includes(project.state)) throw new Error("Стан уже змінився. Онови сторінку перед паузою.");
  return saveStudioProject(familyId, id, project, { state: "paused", token: randomUUID(), activeCall: false, error: "Підготовку призупинено. Готові частини збережено. Уже розпочатий виклик ШІ може завершитися й бути оплаченим; його резерв залишається врахованим у ліміті." });
}
export async function failStudioStep(job: JobRow, error: unknown) {
  const id = String(job.payload.projectId ?? ""); const project = await readStudioProject(job.family_id, id);
  if (project && project.token === job.payload.token && studioActive(project.state)) await saveStudioProject(job.family_id, id, project, { state: "failed", error: safeStageError(error) });
}
/** Project-specific CAS claim: does not start unrelated ingest/warmup jobs. Compatible with generic claim_jobs leases. */
export async function runStudioQueue(familyId: string, projectId: string, token: string, budgetMs = 220000) {
  const scope = forFamily(familyId); const deadline = Date.now() + budgetMs;
  for (let processed = 0; processed < 12 && Date.now() < deadline - 15000; processed++) {
    const found = await scope.select("jobs", "*").eq("type", STUDIO_STEP).eq("status", "queued").eq("payload->>projectId", projectId).eq("payload->>token", token).lte("run_after", new Date().toISOString()).limit(1).maybeSingle<JobRow>();
    if (found.error) throw new Error("Studio queue read failed"); if (!found.data) return;
    const row = found.data;
    const claimed = await scope.update("jobs", { status: "running", attempts: row.attempts + 1, locked_until: new Date(Date.now() + 300000).toISOString() }).eq("id", row.id).eq("status", "queued").select("*").maybeSingle<JobRow>();
    if (claimed.error) throw new Error("Studio queue claim failed"); if (!claimed.data) return;
    try {
      const outcome = await runStudioStep(claimed.data, deadline);
      const saved = await scope.update("jobs", outcome?.requeue ? { status: "queued", attempts: Math.max(0, claimed.data.attempts - 1), locked_until: null, run_after: new Date(Date.now() + (outcome.delaySeconds ?? 0) * 1000).toISOString() } : { status: "done", locked_until: null, last_error: null }).eq("id", row.id).eq("status", "running");
      if (saved.error) throw new Error("Studio queue checkpoint failed");
    } catch (error) {
      await scope.update("jobs", { status: "failed", locked_until: null, last_error: "studio stage failed; see project" }).eq("id", row.id);
      await failStudioStep(claimed.data, error); return;
    }
  }
}
export function registerStudioJobs() {
  registerJobHandler(STUDIO_STEP, { run: (job, ctx) => runStudioStep(job, ctx.deadline), isRetryable: () => false, onGiveUp: failStudioStep });
}
