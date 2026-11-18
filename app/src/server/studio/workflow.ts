import "server-only";
import { AiNotConfiguredError, BudgetBlockedError } from "@/server/ai/types";
import { studioNarrationText, studioModelLesson } from "@/lib/studio-narration";
import { createHash, randomUUID } from "node:crypto";
import { STUDIO_PLAN_BATCH_SIZE, studioPlanBatchSchema, studioDesignSchema, studioLessonSchema, studioAuthorSchema, studioReviewResponseSchema, studioCanAutoResumeReview, studioActive, studioPublicationVisible, type StudioPlan, type StudioProject, type StudioRequest } from "@/lib/studio";
import { enqueueJob, registerJobHandler, type JobRow } from "@/server/jobs/runner";
import { forFamily } from "@/server/db/family-scope";
import { studioBaseCandidates } from "./base-sources";
import { applyStudioResolution, applyStudioAssessment, studioResolveSchema, studioAssessSchema } from "./source-selection";
import { loadStudioSources } from "./sources";
import { createStudioProject, readStudioProject, saveStudioProject, STUDIO_STEP } from "./store";
import { callStudioModel, studioModelConfig, studioReservation, type StudioRole } from "./model";
import { studioSystem } from "./prompts";
import { applyStudioSourceTask, isStudioSourcePhase, prepareStudioLessonSources, studioLessonModelSources, studioPlanSources, studioSourceNoteSchema, studioSourceTask, validateStudioSourcePlan } from "./source-orchestration";
import { studioRepairSchema, applyStudioRepair } from "./repair";
import { saveStudioReviewEvent } from "./review-history";
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
  const available = await studioBaseCandidates(familyId, request);
  const source = available.topics.length ? { sources: [], sourceNotes: ["Шукаємо відповідні готові матеріали базового предмета перед зверненням до книги."], baseHref: null, baseTitle: null, subjectName: available.subjectName, sourceCorpus: undefined, sourceSelection: { candidates: available.topics, fallbackMaterialId: available.fallbackMaterialId, selectedIds: [], assessed: false } } : await loadStudioSources(familyId, { ...request, materialId: request.materialId ?? available.fallbackMaterialId });
  const project: StudioProject = { ...(revisionRequestId ? { revisionRequestId } : {}), version: 1, revision: 0, request, ...source, createdAt: new Date().toISOString(), state: "planning", phase: "sourceSelection" in source ? "resolve" : source.sourceCorpus && source.sourceCorpus.analyzed < source.sourceCorpus.partCount ? "analyze" : "plan", plan: null, units: [], cursor: 0, token: randomUUID(), activeCall: false, spentUsd: 0, heldUsd: 0, feedback: "", error: null, models: [], publication: null };
  const id = await createStudioProject(familyId, project, requestId);
  const saved = await readStudioProject(familyId, id);
  if (saved?.token !== project.token) return id;
  try { await scheduleStudio(familyId, id, project.token); }
  catch { await saveStudioProject(familyId, id, project, { state: "failed", error: "Не вдалося поставити план у чергу. Чернетку збережено; можна повторити." }); }
  return id;
}
export function validateStudioLesson(project: StudioProject, raw: unknown, contextIds?: string[]) {
  const generated = studioAuthorSchema.parse(raw);
  const lesson = studioLessonSchema.parse({ ...generated, blocks: generated.blocks.map(block => ({ ...block, narration: studioNarrationText(block) })) });
  if (Buffer.byteLength(JSON.stringify(lesson)) > 250000) throw new Error("STUDIO-LESSON-SIZE");
  const ids = new Set(contextIds ?? project.units[project.cursor]?.sourceContext?.ids ?? project.lessonSources?.context?.ids ?? project.sources.map(source => source.id));
  if (lesson.sourceIds.some(id => !ids.has(id))) throw new Error("STUDIO-SOURCE-REF");
  if (lesson.blocks.reduce((sum, block) => sum + block.text.length, 0) < 1800 || !lesson.blocks.some(block => block.kind === "explanation") || !lesson.blocks.some(block => block.kind === "example") || !lesson.blocks.some(block => ["practice", "steps"].includes(block.kind))) throw new Error("STUDIO-INCOMPLETE-LESSON");
  if (lesson.questions.some(question => new Set(question.options.map(option => option.toLocaleLowerCase("uk").trim())).size !== 3)) throw new Error("STUDIO-DUPLICATE-OPTIONS");
  const needsWrittenAnswer = (value: string) => /(?:^|[\s.!?,:;])(?:\d+[.)]\s*)?(?:напиши|напишіть|запиши|запишіть|впиши|впишіть|введи|введіть|надрукуй|надрукуйте|дай письмову відповідь|дайте письмову відповідь)(?=\s|[«"“])/iu.test(value);
  if (lesson.questions.some(question => needsWrittenAnswer(question.prompt))) throw new Error("STUDIO-TOUCH-QUIZ");
  if (lesson.blocks.some(block => ["practice", "steps"].includes(block.kind) && needsWrittenAnswer(block.text) && !/за бажанням|необов.?язков/iu.test(block.text))) throw new Error("STUDIO-TYPING-ASSESSMENT");
  if (project.request.targetLanguage) {
    const language = project.request.targetLanguage === "en" ? "en-GB" : "de-DE";
    if (!lesson.blocks.some(block => block.narrationLanguage === language) || !lesson.blocks.some(block => block.kind === "explanation" && /[А-Яа-яІіЇїЄєҐґ]/u.test(block.narration))) throw new Error("STUDIO-LANGUAGE-CONTENT");
    if (lesson.blocks.some(block => block.narrationLanguage === language && (/[\p{Script=Cyrillic}]/u.test(block.narration) || !/[\p{Script=Latin}]/u.test(block.narration)))) throw new Error("STUDIO-NATIVE-NARRATION");
    if (lesson.blocks.some(block => block.narrationLanguage && !["uk-UA", language].includes(block.narrationLanguage))) throw new Error("STUDIO-LANGUAGE-MISMATCH");
  }
  return lesson;
}
class StudioCapError extends Error {
  constructor(readonly requiredUsd: number, readonly availableUsd: number) { super("STUDIO-CAP"); }
}
function safeStageError(error: unknown): string {
  if (error instanceof StudioCapError) return `STUDIO-CAP: для наступного етапу потрібен резерв $${error.requiredUsd.toFixed(3)}, доступно $${Math.max(0, error.availableUsd).toFixed(3)} після врахованих витрат і збережених резервів. Виклик не запускався. Готові частини збережено; ліміт не збільшено.`;
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
  if (project.sourceCorpus && !["plan", "publish", "resolve", "assess"].includes(project.phase) && !isStudioSourcePhase(project.phase) && !project.units[project.cursor]?.sourceContext && !(project.lessonSources?.lessonIndex === project.cursor && project.lessonSources.context)) {
    project = await saveStudioProject(job.family_id, id, project, await prepareStudioLessonSources(job.family_id, project));
    if (isStudioSourcePhase(project.phase)) return { requeue: true as const };
  }
  const sourceTask = isStudioSourcePhase(project.phase) ? await studioSourceTask(job.family_id, project) : null;
  const modelSources = sourceTask?.sources ?? (project.phase === "resolve" ? [] : ["plan", "assess"].includes(project.phase) ? await studioPlanSources(job.family_id, project) : await studioLessonModelSources(job.family_id, project));
  const role: StudioRole = project.phase === "resolve" ? "studio.resolve" : project.phase === "assess" ? "studio.assess" : sourceTask ? "studio.source" : project.phase === "plan" ? "studio.plan" : project.phase === "author" ? "studio.author" : project.phase === "design" ? "studio.design" : project.phase === "repair" ? "studio.repair" : "studio.review";
  const schema = project.phase === "resolve" ? studioResolveSchema : project.phase === "assess" ? studioAssessSchema : sourceTask ? studioSourceNoteSchema : project.phase === "plan" ? studioPlanBatchSchema : project.phase === "author" ? studioAuthorSchema : project.phase === "design" ? studioDesignSchema : project.phase === "repair" ? studioRepairSchema : studioReviewResponseSchema;
  const system = studioSystem(role);
  const planned = project.plan?.lessons.length ?? 0;
  const planningBatch = { startLesson: planned + 1, count: Math.min(STUDIO_PLAN_BATCH_SIZE, project.request.lessonCount - planned), totalLessons: project.request.lessonCount };
  const planContext = project.plan ? { ...project.plan, lessons: project.phase === "plan" ? project.plan.lessons.slice(-STUDIO_PLAN_BATCH_SIZE) : project.plan.lessons.slice(Math.max(0, project.cursor - 2), project.cursor + 3) } : null;
  const candidate = !sourceTask && !["resolve", "assess"].includes(project.phase) && project.units[project.cursor] ? studioModelLesson(project.units[project.cursor]!.content) : null;
  const prompt = JSON.stringify({ request: sourceTask?.scope === "book" ? { purpose: "Незалежний від конкретного курсу огляд усіх наданих частин джерела" } : { ...project.request, hasSelectedMaterial: !!project.request.materialId, sourceText: undefined, subjectId: undefined, topicId: undefined, materialId: undefined }, subject: sourceTask?.scope === "book" ? null : project.subjectName, baseTitle: sourceTask?.scope === "book" ? null : project.baseTitle, plan: sourceTask?.scope === "book" ? null : planContext, ...(project.phase === "plan" ? { planningBatch } : {}), currentLesson: sourceTask?.scope === "book" || project.phase === "plan" ? null : project.plan?.lessons[project.cursor] ?? null, sources: modelSources, sourceNotes: sourceTask?.scope === "book" ? [] : project.sourceNotes, ...(project.phase === "resolve" ? { selectedTopicId: project.request.topicId, availableTopics: project.sourceSelection?.candidates.map(({ id, subjectId, title, pageFrom, pageTo }) => ({ id, subjectId, title, pageFrom, pageTo })) } : {}), ...(sourceTask ? { sourceTask: { scope: sourceTask.scope, reducing: sourceTask.reducing, fromPart: sourceTask.fromPart, toPart: sourceTask.toPart, verifiedQuotes: sourceTask.verifiedQuotes } } : {}), feedback: sourceTask?.scope === "book" ? "" : project.feedback, ...(candidate ? { candidate: { content: project.phase === "design" ? { title: candidate!.title, objectives: candidate!.objectives, blocks: candidate!.blocks } : candidate, visuals: project.units[project.cursor]!.visuals, parentSelectedIllustrations: project.units[project.cursor]!.illustrations?.map(({ title, caption, blockIndex, sourceUrl }) => ({ title, caption, blockIndex, sourceUrl })), ...(project.phase === "repair" ? { review: project.units[project.cursor]!.review } : {}) } } : {}) });
  if (Buffer.byteLength(system + prompt + JSON.stringify(schema.toJSONSchema())) > 250000) throw new Error("STUDIO-CONTEXT");
  const config = await studioModelConfig(job.family_id, role);
  const reserved = studioReservation(system, prompt, schema, config.route.params.max_tokens!, config.rates);
  if (project.spentUsd + project.heldUsd + reserved > project.request.budgetUsd) throw new StudioCapError(reserved, project.request.budgetUsd - project.spentUsd - project.heldUsd);
  project = await saveStudioProject(job.family_id, id, project, { activeCall: true, heldUsd: project.heldUsd + reserved });
  let result;
  try { result = await callStudioModel(job.family_id, id, role, system, prompt, schema, config); }
  catch (error) {
    if (error instanceof AiNotConfiguredError || error instanceof BudgetBlockedError) await saveStudioProject(job.family_id, id, project, { activeCall: false, heldUsd: Math.max(0, project.heldUsd - reserved) });
    throw error;
  }
  const changes: Partial<StudioProject> = { activeCall: false, heldUsd: Math.max(0, project.heldUsd - reserved), spentUsd: project.spentUsd + result.costUsd, models: [...project.models, { role, model: `${result.model.provider}/${result.model.model}`, costUsd: result.costUsd }] };
  try {
  if (project.phase === "resolve") Object.assign(changes, await applyStudioResolution(job.family_id, project, result.result));
  else if (project.phase === "assess") Object.assign(changes, await applyStudioAssessment(job.family_id, project, modelSources, result.result));
  else if (sourceTask) Object.assign(changes, await applyStudioSourceTask(job.family_id, project, sourceTask, result.result));
  else if (project.phase === "plan") {
    const batch = studioPlanBatchSchema.parse(result.result);
    if (batch.lessons.length !== planningBatch.count) throw new Error("STUDIO-PLAN-COUNT");
    const lessons = [...(project.plan?.lessons ?? []), ...batch.lessons];
    if (new Set(lessons.map(lesson => lesson.title.toLocaleLowerCase("uk").trim())).size !== lessons.length) throw new Error("STUDIO-PLAN-DUPLICATE");
    const plan = project.plan ? { ...project.plan, lessons, sourceExclusions: [...new Map([...(project.plan.sourceExclusions ?? []), ...(batch.sourceExclusions ?? [])].map(item => [item.sourceId, item])).values()] } : batch;
    await validateStudioSourcePlan(job.family_id, project, plan, lessons.length === project.request.lessonCount);
    Object.assign(changes, { plan, state: lessons.length === project.request.lessonCount ? "plan_ready" : "planning" });
  } else {
    const units = [...project.units];
    if (project.phase === "author") {
      units[project.cursor] = { ...units[project.cursor], content: validateStudioLesson(project, result.result, modelSources.map(source => source.id)), sourceContext: project.units[project.cursor]?.sourceContext ?? project.lessonSources?.context, visuals: units[project.cursor]?.visuals ?? [], review: null }; changes.phase = "design";
    } else if (project.phase === "design") {
      const { visuals } = studioDesignSchema.parse(result.result);
      if (visuals.some(visual => visual.blockIndex >= units[project.cursor]!.content.blocks.length || (visual.kind === "dimensions" && (!visual.width || !visual.height || !visual.unit)))) throw new Error("STUDIO-VISUAL-REF");
      units[project.cursor] = { ...units[project.cursor]!, visuals }; changes.phase = "review";
    } else if (project.phase === "repair") {
      const repaired = applyStudioRepair(units[project.cursor]!, result.result);
      validateStudioLesson(project, repaired.unit.content, modelSources.map(source => source.id));
      units[project.cursor] = repaired.unit;
      Object.assign(changes, { phase: "review", repairAdvice: repaired.diagnosis, feedback: `${studioReviewFeedback(project.units[project.cursor]!.review)}\nДіагностичне виправлення: ${repaired.diagnosis}\nПеревір за контрактом незалежно, не довіряй висновку редактора без перевірки: ${repaired.reviewAdvice}` });
    } else {
      const review = studioReviewResponseSchema.parse(result.result);
      if (review.corrections.some(fix => (fix.blockIndex !== null && fix.blockIndex >= units[project.cursor]!.content.blocks.length) || (fix.visualIndex !== null && fix.visualIndex >= units[project.cursor]!.visuals.length))) throw new Error("STUDIO-CORRECTION-REF");
      if (review.verdict !== "pass" && (!review.corrections.length || review.corrections.length !== review.issues.length)) throw new Error("STUDIO-CORRECTION-MISSING");
      if (review.verdict === "pass" && (review.issues.length || review.corrections.length)) throw new Error("STUDIO-REVIEW-CONFLICT");
      const round = (units[project.cursor]!.reviewRound ?? 0) + 1;
      const fingerprint = createHash("sha256").update(JSON.stringify({ content: units[project.cursor]!.content, visuals: units[project.cursor]!.visuals, corrections: review.corrections.map(fix => JSON.stringify(fix)).sort(), issues: [...review.issues].sort() })).digest("hex");
      const stuck = review.verdict !== "pass" && units[project.cursor]!.lastReviewFingerprint === fingerprint;
      const escalate = stuck && !project.reviewRepairAttempted && !project.reviewOnly;
      const stop = !!project.reviewOnly || (stuck && !escalate);
      const nextPhase = review.corrections.length && review.corrections.every(fix => fix.role === "design") ? "design" : "author";
      units[project.cursor] = { ...units[project.cursor]!, review, reviewRound: round, lastReviewFingerprint: review.verdict === "pass" ? null : fingerprint };
      await saveStudioReviewEvent(job.family_id, id, token, project.revision, { at: new Date().toISOString(), lessonIndex: project.cursor, round, review, next: review.verdict === "pass" ? "ready" : project.reviewOnly ? "parent" : stop ? "stopped" : escalate ? "repair" : nextPhase });
      if (review.verdict !== "pass") Object.assign(changes, { state: stop ? "needs_changes" : "generating", phase: escalate ? "repair" : nextPhase, reviewRepairAttempted: project.reviewRepairAttempted || escalate, reviewAutomationStopped: stop, error: stop && !project.reviewOnly ? "STUDIO-NO-PROGRESS: звичайні й діагностичні виправлення не змінили результат. Нові платні етапи зупинено. Переглянь рецензію та діагноз нижче; матеріал збережено." : null, feedback: `${studioReviewFeedback(review)}\nПобажання тата: ${project.revisionInstructions ?? project.editorNotes?.at(-1)?.text ?? ""}` });
      else {
        const next = project.plan!.lessons.findIndex((_lesson, index) => units[index]?.review?.verdict !== "pass");
        if (next < 0) { changes.state = "ready"; changes.reviewOnly = false; changes.reviewAutomationStopped = false; changes.error = null; }
        else Object.assign(changes, { ...(project.reviewOnly ? { state: "paused", reviewOnly: false, error: "Повторну рецензію цього уроку завершено. Решту курсу збережено; продовж підготовку окремо." } : {}), cursor: next, phase: "author", feedback: "", revisionInstructions: "", reviewRepairAttempted: false, repairAdvice: "", reviewAutomationStopped: false });
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
export async function resumeStudio(familyId: string, id: string, revision: number, command: "approve" | "retry" | "revise" | "publish" | "review", plan?: StudioPlan, feedback = "", budgetUsd?: number, lessonIndex?: number, revisionRequestId?: string, learner?: { age: number; grade: number }) {
  const project = await readStudioProject(familyId, id);
  if (!project || project.revision !== revision || studioActive(project.state) || (["published", "withdrawn"].includes(project.state) && command !== "revise")) throw new Error("Онови чернетку перед дією.");
  const token = randomUUID();
  let changes: Partial<StudioProject> = { ...(revisionRequestId ? { revisionRequestId } : {}), token, activeCall: false, error: null, reviewOnly: command === "retry" && project.reviewOnly === true };
  if (budgetUsd !== undefined) changes.request = { ...project.request, budgetUsd };
  if (learner) changes.request = { ...(changes.request ?? project.request), age: learner.age, grade: learner.grade };
  if (command === "approve") {
    if (project.state !== "plan_ready" || !plan || plan.lessons.length !== project.request.lessonCount) throw new Error("Перевір план та кількість уроків.");
    await validateStudioSourcePlan(familyId, project, plan);
    changes = { ...changes, plan, state: "generating", phase: "author", cursor: 0, units: [], lessonSources: undefined };
  } else if (command === "publish") {
    if (project.state !== "ready" || project.units.length !== project.plan?.lessons.length || project.units.some(unit => unit.review?.verdict !== "pass")) throw new Error("Спочатку потрібні готові уроки й позитивна рецензія.");
    changes = { ...changes, state: "publishing", phase: "publish" };
  } else if (command === "review") {
    const cursor = lessonIndex ?? project.cursor;
    if (!["failed", "paused", "needs_changes"].includes(project.state) || project.phase === "publish" || !project.plan || !Number.isSafeInteger(cursor) || !project.plan.lessons[cursor] || !project.units[cursor]) throw new Error("Повторна рецензія доступна для збереженого чернеткового уроку після зупинки.");
    const units = project.units.map((unit, index) => index === cursor ? { ...unit, lastReviewFingerprint: null } : unit);
    changes = { ...changes, units, cursor, phase: "review", state: "generating", reviewOnly: true, reviewAutomationStopped: false, reviewRepairAttempted: false, repairAdvice: "", feedback: "Незалежно перевір поточний готовий урок за актуальним контрактом. Попередні зауваження не є доказом помилки. Після вердикту підготовка зупиниться для батьківського рішення." };
  } else if (command === "revise") {
    const cursor = lessonIndex ?? project.cursor;
    if (!["needs_changes", "ready", "published", "withdrawn"].includes(project.state) || !Number.isSafeInteger(cursor) || !project.units[cursor]) throw new Error("Немає уроку для виправлення.");
    if (["published", "withdrawn"].includes(project.state) && !feedback.trim()) throw new Error("Опиши, що потрібно виправити в опублікованому уроці.");
    if (project.request.materialId && !project.sourceCorpus) changes = { ...changes, ...await loadStudioSources(familyId, changes.request ?? project.request) };
    const review = project.units[cursor]!.review;
    // Only structured, exclusively visual corrections can skip authoring. Legacy reviews
    // and parent instructions still receive a full, contextual revision.
    const designOnly = !feedback.trim() && review?.corrections?.length && review.corrections.every(fix => fix.role === "design");
    const units = project.units.map((unit, index) => index === cursor ? { ...unit, lastReviewFingerprint: null } : unit);
    changes = { ...changes, units, reviewAutomationStopped: false, reviewRepairAttempted: false, repairAdvice: "", revisionInstructions: feedback.trim(), state: "generating", publicationRevision: project.publicationRevision || !!project.publication, childAccess: studioPublicationVisible(project) ? "enabled" : "disabled", editorNotes: [...(project.editorNotes ?? []), { at: new Date().toISOString(), lessonIndex: cursor, text: feedback.trim() || "Виправити зауваження рецензента" }].slice(-30), phase: designOnly ? "design" : "author", cursor, feedback: `${studioReviewFeedback(review)}\nПобажання тата: ${feedback}` };
  } else {
    if (!["failed", "paused"].includes(project.state)) throw new Error("Продовження доступне після паузи або збою етапу.");
    if (project.request.materialId && !project.sourceCorpus) changes = { ...changes, ...await loadStudioSources(familyId, changes.request ?? project.request) };
    changes.state = ["resolve", "assess", "analyze", "outline", "plan"].includes(project.phase) ? "planning" : project.phase === "publish" ? "publishing" : "generating";
  }
  if (changes.sourceCorpus && !project.sourceCorpus) Object.assign(changes, { state: "planning", phase: "analyze", plan: null, lessonSources: undefined, cursor: 0 });
  const next = await saveStudioProject(familyId, id, project, changes);
  try { await scheduleStudio(familyId, id, token); }
  catch { await saveStudioProject(familyId, id, next, { state: "failed", error: "Чернетку збережено, але черга недоступна. Повтори етап пізніше." }); }
}
export async function resumeLegacyStudioReview(familyId: string, id: string) {
  const project = await readStudioProject(familyId, id);
  if (!project || !studioCanAutoResumeReview(project)) return project;
  const review = project.units[project.cursor]?.review;
  if (!review || review.verdict === "pass") return project;
  const token = randomUUID();
  const next = await saveStudioProject(familyId, id, project, { token, state: "generating", phase: project.reviewAutomationStopped ? "repair" : review.corrections?.length && review.corrections.every(fix => fix.role === "design") ? "design" : "author", reviewRepairAttempted: project.reviewAutomationStopped || project.reviewRepairAttempted, reviewAutomationStopped: false, revisionInstructions: project.revisionInstructions ?? project.editorNotes?.at(-1)?.text ?? "", error: null, feedback: `${studioReviewFeedback(review)}\nПобажання тата: ${project.revisionInstructions ?? project.editorNotes?.at(-1)?.text ?? ""}` });
  try { await scheduleStudio(familyId, id, token); }
  catch { return saveStudioProject(familyId, id, next, { state: "failed", error: "Не вдалося продовжити цикл рецензії. Чернетку збережено." }); }
  return next;
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
  registerJobHandler(STUDIO_STEP, { run: async (job, ctx) => {
    const outcome = await runStudioStep(job, ctx.deadline);
    if (outcome?.requeue) { const { dispatchStudioContinuation } = await import("./wake"); dispatchStudioContinuation(job.family_id, String(job.payload.projectId), String(job.payload.token)); }
    return outcome;
  }, isRetryable: () => false, onGiveUp: failStudioStep });
}
