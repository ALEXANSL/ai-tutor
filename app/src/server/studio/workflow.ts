import "server-only";
import { readStudioPaidResult, writeStudioPaidResult, type StudioPaidModelResult } from "./paid-result";
import { studioFailureDiagnostic, studioFailureMessage, StudioCapturedOutputError } from "./diagnostics";
import { studioPlanStageSchema, studioSourceStageSchema } from "./stage-schema";
import { retrieveStudioResponse } from "@/server/ai/providers/openai";
import { estimateCostUsd } from "@/server/ai/policy";
import { recordCall } from "@/server/ai/store";
import { BackgroundResponsePending, AiNotConfiguredError, BudgetBlockedError, ProviderError } from "@/server/ai/types";
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
import { reusePreparedLessonSources, applyStudioSourceTask, isStudioSourcePhase, prepareStudioLessonSources, studioLessonModelSources, studioPlanSources, studioSourceTask, validateStudioSourcePlan } from "./source-orchestration";
import { studioRepairSchema, applyStudioRepair } from "./repair";
import { saveStudioReviewEvent } from "./review-history";
import { activateStudioPublication, prepareStudioPublication } from "./publish";

function pendingStudioRole(phase: StudioProject["phase"]): StudioRole {
  return phase === "resolve" ? "studio.resolve" : phase === "assess" ? "studio.assess" : ["analyze", "outline", "lesson_sources", "lesson_outline"].includes(phase) ? "studio.source" : phase === "plan" ? "studio.plan" : phase === "author" ? "studio.author" : phase === "design" ? "studio.design" : phase === "repair" ? "studio.repair" : "studio.review";
}
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
  const project: StudioProject = { autonomous: true, ...(revisionRequestId ? { revisionRequestId } : {}), version: 1, revision: 0, request, ...source, createdAt: new Date().toISOString(), state: "planning", phase: "sourceSelection" in source ? "resolve" : source.sourceCorpus && source.sourceCorpus.analyzed < source.sourceCorpus.partCount ? "analyze" : "plan", plan: null, units: [], cursor: 0, token: randomUUID(), activeCall: false, spentUsd: 0, heldUsd: 0, feedback: "", error: null, models: [], publication: null };
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
  if (error instanceof Error && error.message.startsWith("STUDIO-RESULT")) return "STUDIO-RESULT: не вдалося підтвердити збережену відповідь для цього контексту. Новий платний виклик не запускався; резерв не видалено.";
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
  if (deadline - Date.now() < 145000) return { requeue: true as const, delaySeconds: 10 };
  if (project.phase === "publish") {
    const publication = project.publicationRevision ? await prepareStudioPublication(job.family_id, id, project) : project.publication ?? await prepareStudioPublication(job.family_id, id, project);
    project = await saveStudioProject(job.family_id, id, project, { publication });
    await activateStudioPublication(job.family_id, publication, !project.request.subjectId);
    await saveStudioProject(job.family_id, id, project, { state: "published", publicationRevision: false, childAccess: "enabled", error: null }); return;
  }
  // Poll by response ID before rebuilding the book context. Only completed work needs sources.
  const pending = project.pendingModelCall;
  if (project.phase === "author" && pending?.phase === "author" && pending.cursor === project.cursor && pending.background && !await readStudioPaidResult(job.family_id, id, pending)) {
    const background = pending.background;
    const age = Date.now() - background.started;
    let retrieved;
    try { retrieved = await retrieveStudioResponse(background.id, studioAuthorSchema); }
    catch (error) {
      if (error instanceof ProviderError && error.retryable && age < 3600000) return { requeue: true as const, delaySeconds: 15 };
      throw error;
    }
    if ("pending" in retrieved) {
      const last = background.observation;
      if (last?.status !== retrieved.pending || Date.now() - last.at >= 60000) {
        await saveStudioProject(job.family_id, id, project, { pendingModelCall: {
          ...pending, background: { ...background, observation: { status: retrieved.pending, at: Date.now() } },
        } });
      }
      if (age > 3600000) throw new Error("STUDIO-BACKGROUND-WAIT");
      return { requeue: true as const, delaySeconds: 15 };
    }
    const {usage, data} = retrieved;
    const costUsd = estimateCostUsd(background.rates, usage);
    const result = { ...data, model: { provider: "openai", model: background.model }, costUsd };
    await writeStudioPaidResult(job.family_id, id, pending, result);
    await recordCall(job.family_id, { role: background.role, provider: "openai", model: background.model, status: "ok", input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cached_input_tokens: usage.cachedInputTokens ?? 0, cache_write_tokens: 0, latency_ms: age, fallback_used: false, cost_usd: costUsd, ref_table: "jobs", ref_id: id });
  }
  if (project.sourceCorpus && !["plan", "publish", "resolve", "assess"].includes(project.phase) && !isStudioSourcePhase(project.phase) && !project.units[project.cursor]?.sourceContext && !(project.lessonSources?.lessonIndex === project.cursor && project.lessonSources.context)) {
    project = await saveStudioProject(job.family_id, id, project, await prepareStudioLessonSources(job.family_id, project));
    if (isStudioSourcePhase(project.phase)) return { requeue: true as const };
  }
  if (project.phase === "lesson_sources" && !project.pendingModelCall && !project.activeCall && !project.regeneration) {
    const prepared = await reusePreparedLessonSources(job.family_id, project);
    if (prepared) {
      await saveStudioProject(job.family_id, id, project, prepared);
      return { requeue: true as const };
    }
  }
  const sourceTask = isStudioSourcePhase(project.phase) ? await studioSourceTask(job.family_id, project) : null;
  const modelSources = sourceTask?.sources ?? (project.phase === "resolve" ? [] : ["plan", "assess"].includes(project.phase) ? await studioPlanSources(job.family_id, project) : await studioLessonModelSources(job.family_id, project));
  const role: StudioRole = project.phase === "resolve" ? "studio.resolve" : project.phase === "assess" ? "studio.assess" : sourceTask ? "studio.source" : project.phase === "plan" ? "studio.plan" : project.phase === "author" ? "studio.author" : project.phase === "design" ? "studio.design" : project.phase === "repair" ? "studio.repair" : "studio.review";
  const planned = project.plan?.lessons.length ?? 0;
  const planningBatch = { startLesson: planned + 1, count: Math.min(STUDIO_PLAN_BATCH_SIZE, project.request.lessonCount - planned), totalLessons: project.request.lessonCount };
  const schema = project.phase === "resolve" ? studioResolveSchema : project.phase === "assess" ? studioAssessSchema : sourceTask ? studioSourceStageSchema(sourceTask) : project.phase === "plan" ? studioPlanStageSchema(planningBatch.count, modelSources, !!project.sourceCorpus) : project.phase === "author" ? studioAuthorSchema : project.phase === "design" ? studioDesignSchema : project.phase === "repair" ? studioRepairSchema : studioReviewResponseSchema;
  const system = studioSystem(role);
  const planContext = project.plan ? { ...project.plan, lessons: project.phase === "plan" ? project.plan.lessons.slice(-STUDIO_PLAN_BATCH_SIZE) : project.plan.lessons.slice(Math.max(0, project.cursor - 2), project.cursor + 3) } : null;
  const candidate = !sourceTask && !["resolve", "assess"].includes(project.phase) && project.units[project.cursor] ? studioModelLesson(project.units[project.cursor]!.content) : null;
  const rejected = project.regeneration ? await readStudioPaidResult(job.family_id, id, project.regeneration.pending) : null;
  const prompt = JSON.stringify({ request: sourceTask?.scope === "book" ? { purpose: "Незалежний від конкретного курсу огляд усіх наданих частин джерела" } : { ...project.request, hasSelectedMaterial: !!project.request.materialId, sourceText: undefined, subjectId: undefined, topicId: undefined, materialId: undefined }, subject: sourceTask?.scope === "book" ? null : project.subjectName, baseTitle: sourceTask?.scope === "book" ? null : project.baseTitle, plan: sourceTask?.scope === "book" ? null : planContext, ...(project.phase === "plan" ? { planningBatch } : {}), currentLesson: sourceTask?.scope === "book" || project.phase === "plan" ? null : project.plan?.lessons[project.cursor] ?? null, sources: modelSources, sourceNotes: sourceTask?.scope === "book" ? [] : project.sourceNotes, ...(project.phase === "resolve" ? { selectedTopicId: project.request.topicId, availableTopics: project.sourceSelection?.candidates.map(({ id, subjectId, title, pageFrom, pageTo }) => ({ id, subjectId, title, pageFrom, pageTo })) } : {}), ...(sourceTask ? { sourceTask: { scope: sourceTask.scope, reducing: sourceTask.reducing, fromPart: sourceTask.fromPart, toPart: sourceTask.toPart, verifiedQuotes: sourceTask.verifiedQuotes } } : {}), feedback: sourceTask?.scope === "book" ? "" : project.feedback, ...(project.regeneration ? { validationRepair: { diagnostic: project.regeneration.diagnostic, rejectedResult: rejected?.result, instruction: "Виправ саме цю помилку за поточною схемою. Збережи правильний зміст; не повторюй відхилену відповідь." } } : {}), ...(candidate ? { candidate: { content: project.phase === "design" ? { title: candidate!.title, objectives: candidate!.objectives, blocks: candidate!.blocks } : candidate, visuals: project.units[project.cursor]!.visuals, parentSelectedIllustrations: project.units[project.cursor]!.illustrations?.map(({ title, caption, blockIndex, sourceUrl }) => ({ title, caption, blockIndex, sourceUrl })), ...(project.phase === "repair" ? { review: project.units[project.cursor]!.review } : {}) } } : {}) });
  if (Buffer.byteLength(system + prompt + JSON.stringify(schema.toJSONSchema())) > 250000) throw new Error("STUDIO-CONTEXT");
  const context = JSON.parse(prompt); if (context.request) delete context.request.budgetUsd;
  const inputHash = createHash("sha256").update(JSON.stringify({ phase: project.phase, cursor: project.cursor, context })).digest("hex");
  let result: StudioPaidModelResult;
  if (project.pendingModelCall) {
    const pending = project.pendingModelCall;
    const saved = await readStudioPaidResult(job.family_id, id, pending);
    if (saved) result = saved;
    else throw new Error("STUDIO-UNCERTAIN-CALL");
  } else {
    if (project.activeCall) throw new Error("STUDIO-UNCERTAIN-CALL");
    const config = await studioModelConfig(job.family_id, role, project.unavailableSpecialists?.includes(role));
    // Hand the job to a fresh worker before reserving or sending a paid call.
    if (deadline - Date.now() < (config.route.params.timeout_ms ?? 120000) + 25000) {
      return { requeue: true as const, delaySeconds: 1 };
    }
    const reserved = studioReservation(system, prompt, schema, config.route.params.max_tokens!, config.rates);
    if (project.spentUsd + project.heldUsd + reserved > project.request.budgetUsd) throw new StudioCapError(reserved, project.request.budgetUsd - project.spentUsd - project.heldUsd);
    const pending = { id: randomUUID(), phase: project.phase, cursor: project.cursor, inputHash, reservedUsd: reserved, billed: false };
    project = await saveStudioProject(job.family_id, id, project, { activeCall: true, heldUsd: project.heldUsd + reserved, pendingModelCall: pending });
    try { result = await callStudioModel(job.family_id, id, role, system, prompt, schema, config); }
    catch (error) {
      if (error instanceof BackgroundResponsePending) {
        const current = await readStudioProject(job.family_id, id);
        if (!current || current.pendingModelCall?.id !== pending.id) throw new Error("STUDIO-RESULT-CONTEXT");
        await saveStudioProject(job.family_id, id, current, { pendingModelCall: { ...pending, background: { id: error.responseId, started: Date.now(), model: config.route.primary_model, role: config.route.role, rates: config.rates } } });
        return { requeue: true as const, delaySeconds: 15 };
      }
      if (project.autonomous && project.lastTransportRetryHash !== inputHash && error instanceof ProviderError && error.retryable && (error.status === null || error.status >= 500)) {
        await saveStudioProject(job.family_id, id, project, {
          activeCall: false, pendingModelCall: undefined, lastTransportRetryHash: inputHash,
          unresolvedModelCalls: [...(project.unresolvedModelCalls ?? []), pending],
          ...(config.specialist ? { unavailableSpecialists: [...(project.unavailableSpecialists ?? []), role] } : {}),
        });
        return { requeue: true as const, delaySeconds: 10 };
      }
      if (config.specialist && error instanceof ProviderError && [400, 401, 403, 404, 429].includes(error.status ?? 0)) {
        await saveStudioProject(job.family_id, id, project, {
          unavailableSpecialists: [...(project.unavailableSpecialists ?? []), role],
          activeCall: false, pendingModelCall: undefined, heldUsd: Math.max(0, project.heldUsd - reserved),
        });
        return { requeue: true as const, delaySeconds: 1 };
      }
      if (error instanceof ProviderError && error.status === 429 && project.lastRateLimitRetryHash !== inputHash) {
        await saveStudioProject(job.family_id, id, project, {
          activeCall: false,
          pendingModelCall: undefined,
          heldUsd: Math.max(0, project.heldUsd - reserved),
          lastRateLimitRetryHash: inputHash,
        });
        return { requeue: true as const, delaySeconds: 30 };
      }
      if (error instanceof AiNotConfiguredError || error instanceof BudgetBlockedError || (error instanceof ProviderError && error.status !== null && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status))) await saveStudioProject(job.family_id, id, project, { activeCall: false, pendingModelCall: undefined, heldUsd: Math.max(0, project.heldUsd - reserved) });
      throw error;
    }
    await writeStudioPaidResult(job.family_id, id, pending, result);
  }
  if (!project.pendingModelCall!.billed) {
    project = await saveStudioProject(job.family_id, id, project, { activeCall: false, heldUsd: Math.max(0, project.heldUsd - project.pendingModelCall!.reservedUsd), spentUsd: project.spentUsd + result.costUsd, models: [...project.models, { role: pendingStudioRole(project.pendingModelCall!.phase), model: `${result.model.provider}/${result.model.model}`, costUsd: result.costUsd }], pendingModelCall: { ...project.pendingModelCall!, billed: true } });
  }
  if (project.pendingModelCall!.phase !== project.phase || project.pendingModelCall!.cursor !== project.cursor || project.pendingModelCall!.inputHash !== inputHash) throw new Error("STUDIO-RESULT-CONTEXT");
  const changes: Partial<StudioProject> = {};
  try {
  if (result.failure) throw new StudioCapturedOutputError(result.failure);
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
    const planComplete = lessons.length === project.request.lessonCount;
    Object.assign(changes, { plan, state: planComplete ? "plan_ready" : "planning" });
    if (planComplete && project.autonomous) Object.assign(changes, { state: "generating", phase: "author", cursor: 0 });
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
      const failures = review.verdict === "pass" ? 0 : (project.consecutiveReviewFailures ?? 0) + 1;
      const unresolved = stuck || failures >= 3;
      const escalate = unresolved && !project.reviewRepairAttempted && !project.reviewOnly;
      const stop = !!project.reviewOnly || (unresolved && !escalate);
      changes.consecutiveReviewFailures = failures;
      const nextPhase = review.corrections.length && review.corrections.every(fix => fix.role === "design") ? "design" : failures <= 2 ? "repair" : "author";
      units[project.cursor] = { ...units[project.cursor]!, review, reviewRound: round, lastReviewFingerprint: review.verdict === "pass" ? null : fingerprint };
      await saveStudioReviewEvent(job.family_id, id, project.pendingModelCall?.id ?? token, project.pendingModelCall ? 0 : project.revision, { at: new Date().toISOString(), lessonIndex: project.cursor, round, review, next: review.verdict === "pass" ? "ready" : project.reviewOnly ? "parent" : stop ? "stopped" : escalate ? "repair" : nextPhase });
      if (review.verdict !== "pass") Object.assign(changes, { state: stop ? "needs_changes" : "generating", phase: escalate ? "repair" : nextPhase, reviewRepairAttempted: project.reviewRepairAttempted || escalate, reviewAutomationStopped: stop, error: stop && !project.reviewOnly ? "STUDIO-NO-PROGRESS: після доопрацювання й незалежної перевірки залишилися блокувальні зауваження. Нові платні етапи зупинено. Переглянь рецензію та діагноз нижче; матеріал збережено." : null, feedback: `${studioReviewFeedback(review)}\nПобажання тата: ${project.revisionInstructions ?? project.editorNotes?.at(-1)?.text ?? ""}` });
      else {
        const next = project.plan!.lessons.findIndex((_lesson, index) => units[index]?.review?.verdict !== "pass");
        if (next < 0) { changes.state = "ready"; changes.reviewOnly = false; changes.reviewAutomationStopped = false; changes.error = null; }
        else Object.assign(changes, { ...(project.reviewOnly ? { state: "paused", reviewOnly: false, error: "Повторну рецензію цього уроку завершено. Решту курсу збережено; продовж підготовку окремо." } : {}), cursor: next, phase: "author", feedback: "", revisionInstructions: "", reviewRepairAttempted: false, consecutiveReviewFailures: 0, repairAdvice: "", reviewAutomationStopped: false });
      }
    }
    changes.units = units;
  }
  } catch (error) {
    const diagnostic = studioFailureDiagnostic(error, project.phase);
    if ((project.autonomous || diagnostic.code === "STUDIO-AI-INCOMPLETE") && diagnostic.category === "content" && !project.regeneration && project.pendingModelCall?.billed && !project.reviewOnly) {
      await saveStudioProject(job.family_id, id, project, {
        activeCall: false, pendingModelCall: undefined,
        regeneration: { pending: project.pendingModelCall, diagnostic },
      });
      return { requeue: true as const };
    }
    await saveStudioProject(job.family_id, id, project, { activeCall: false, state: "failed", failureDiagnostic: diagnostic, error: studioFailureMessage(diagnostic, true) }); return;
  }
  const next = await saveStudioProject(job.family_id, id, project, { ...changes, pendingModelCall: undefined, regeneration: undefined, failureDiagnostic: undefined, error: changes.error ?? null });
  if (studioActive(next.state)) return { requeue: true as const };
}
export async function resumeStudio(familyId: string, id: string, revision: number, command: "approve" | "retry" | "revise" | "publish" | "review" | "regenerate" | "restart", plan?: StudioPlan, feedback = "", budgetUsd?: number, lessonIndex?: number, revisionRequestId?: string, learner?: { age: number; grade: number }) {
  const project = await readStudioProject(familyId, id);
  if (!project || project.revision !== revision || studioActive(project.state) || (["published", "withdrawn"].includes(project.state) && command !== "revise")) throw new Error("Онови чернетку перед дією.");
  if (project.pendingModelCall && !["retry", "regenerate", "restart"].includes(command)) throw new Error("Спочатку повторно перевір збережену відповідь або явно згенеруй нову; контекст незавершеного виклику не змінено.");
  if (project.pendingModelCall && learner && (learner.age !== project.request.age || learner.grade !== project.request.grade)) throw new Error("Спочатку опрацюй збережену відповідь; вік і клас незавершеного етапу не змінено.");
  const token = randomUUID();
  let changes: Partial<StudioProject> = { ...(revisionRequestId ? { revisionRequestId } : {}), token, activeCall: false, error: null, failureDiagnostic: undefined, reviewOnly: ["retry", "regenerate", "restart"].includes(command) && project.reviewOnly === true };
  if (budgetUsd !== undefined) changes.request = { ...project.request, budgetUsd };
  if (learner) changes.request = { ...(changes.request ?? project.request), age: learner.age, grade: learner.grade };
  if (command === "approve") {
    if (project.state !== "plan_ready" || !plan || plan.lessons.length !== project.request.lessonCount) throw new Error("Перевір план та кількість уроків.");
    await validateStudioSourcePlan(familyId, project, plan);
    changes = { ...changes, plan, state: "generating", phase: "author", cursor: 0, units: [], lessonSources: undefined };
  } else if (command === "publish") {
    if (project.state !== "ready" || project.units.length !== project.plan?.lessons.length || project.units.some(unit => unit.review?.verdict !== "pass")) throw new Error("Спочатку потрібні готові уроки й позитивна рецензія.");
    changes = { ...changes, state: "publishing", phase: "publish" };
  } else if (command === "regenerate") {
    if (project.state !== "failed" || !project.pendingModelCall?.billed || project.failureDiagnostic?.category !== "content") throw new Error("Нова відповідь доступна після підтвердженої помилки збереженого результату.");
    changes = { ...changes, pendingModelCall: undefined, regeneration: { pending: project.pendingModelCall, diagnostic: project.failureDiagnostic }, state: ["resolve", "assess", "analyze", "outline", "plan"].includes(project.phase) ? "planning" : "generating" };
  } else if (command === "restart") {
    if (!["failed", "paused"].includes(project.state) || !project.pendingModelCall || project.pendingModelCall.billed) throw new Error("Платний повтор доступний лише для виклику без підтвердженої відповіді.");
    changes.state = ["resolve", "assess", "analyze", "outline", "plan"].includes(project.phase) ? "planning" : "generating";
  } else if (command === "review") {
    const cursor = lessonIndex ?? project.cursor;
    if (!["failed", "paused", "needs_changes"].includes(project.state) || project.phase === "publish" || !project.plan || !Number.isSafeInteger(cursor) || !project.plan.lessons[cursor] || !project.units[cursor]) throw new Error("Повторна рецензія доступна для збереженого чернеткового уроку після зупинки.");
    const units = project.units.map((unit, index) => index === cursor ? { ...unit, lastReviewFingerprint: null } : unit);
    changes = { ...changes, units, cursor, phase: "review", state: "generating", reviewOnly: true, reviewAutomationStopped: false, reviewRepairAttempted: false, consecutiveReviewFailures: 0, repairAdvice: "", feedback: "Незалежно перевір поточний готовий урок за актуальним контрактом. Попередні зауваження не є доказом помилки. Після вердикту підготовка зупиниться для батьківського рішення." };
  } else if (command === "revise") {
    const cursor = lessonIndex ?? project.cursor;
    if (!["needs_changes", "ready", "published", "withdrawn"].includes(project.state) || !Number.isSafeInteger(cursor) || !project.units[cursor]) throw new Error("Немає уроку для виправлення.");
    if (["published", "withdrawn"].includes(project.state) && !feedback.trim()) throw new Error("Опиши, що потрібно виправити в опублікованому уроці.");
    if (project.request.materialId && !project.sourceCorpus && !project.pendingModelCall) changes = { ...changes, ...await loadStudioSources(familyId, changes.request ?? project.request) };
    const review = project.units[cursor]!.review;
    // Only structured, exclusively visual corrections can skip authoring. Legacy reviews
    // and parent instructions still receive a full, contextual revision.
    const designOnly = !feedback.trim() && review?.corrections?.length && review.corrections.every(fix => fix.role === "design");
    const units = project.units.map((unit, index) => index === cursor ? { ...unit, lastReviewFingerprint: null } : unit);
    changes = { ...changes, units, reviewAutomationStopped: false, reviewRepairAttempted: false, consecutiveReviewFailures: 0, repairAdvice: "", revisionInstructions: feedback.trim(), state: "generating", publicationRevision: project.publicationRevision || !!project.publication, childAccess: studioPublicationVisible(project) ? "enabled" : "disabled", editorNotes: [...(project.editorNotes ?? []), { at: new Date().toISOString(), lessonIndex: cursor, text: feedback.trim() || "Виправити зауваження рецензента" }].slice(-30), phase: designOnly ? "design" : "author", cursor, feedback: `${studioReviewFeedback(review)}\nПобажання тата: ${feedback}` };
  } else {
    if (!["failed", "paused"].includes(project.state)) throw new Error("Продовження доступне після паузи або збою етапу.");
    if (project.request.materialId && !project.sourceCorpus && !project.pendingModelCall) changes = { ...changes, ...await loadStudioSources(familyId, changes.request ?? project.request) };
    changes.state = ["resolve", "assess", "analyze", "outline", "plan"].includes(project.phase) ? "planning" : project.phase === "publish" ? "publishing" : "generating";
  }
  if (["retry", "restart"].includes(command) && project.pendingModelCall && !project.pendingModelCall.billed) {
    const receipt = await readStudioPaidResult(familyId, id, project.pendingModelCall);
    if (!receipt && !project.pendingModelCall.background && command === "retry") {
      const uncertain = studioFailureDiagnostic(new Error("STUDIO-AI-UNCERTAIN"), project.phase);
      await saveStudioProject(familyId, id, project, { ...changes, state: "failed", failureDiagnostic: project.failureDiagnostic ?? uncertain, error: studioFailureMessage(uncertain, false) });
      return;
    }
    if (!receipt && !project.pendingModelCall.background && command === "restart" && project.phase === "lesson_sources" && project.lessonSources) {
      changes.lessonSources = { ...project.lessonSources, recoverySlice: project.lessonSources.recoverySlice ?? 0 };
    }
    if (!receipt && !project.pendingModelCall.background) Object.assign(changes, { pendingModelCall: undefined, unresolvedModelCalls: [...(project.unresolvedModelCalls ?? []), project.pendingModelCall] });
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
  if (project && project.token === job.payload.token && studioActive(project.state)) await saveStudioProject(job.family_id, id, project, { state: "failed", failureDiagnostic: studioFailureDiagnostic(error, project.phase), error: error instanceof ProviderError ? studioFailureMessage(studioFailureDiagnostic(error, project.phase), false) : safeStageError(error) });
}
/** Project-specific CAS claim: does not start unrelated ingest/warmup jobs. Compatible with generic claim_jobs leases. */
export async function runStudioQueue(familyId: string, projectId: string, token: string, budgetMs = 255000) {
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
