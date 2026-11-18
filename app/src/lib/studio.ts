import { z } from "zod";
export const STUDIO_PLAN_BATCH_SIZE = 6;
export const STUDIO_MAX_QUIZZES = 24;
export const STUDIO_MAX_BLOCKS = 24;
export const STUDIO_MAX_SOURCE_CHUNKS = 200;
export const STUDIO_MAX_BUDGET = 250;
const text = (max = 4000) => z.string().trim().min(1).max(max);
export const studioRequestSchema = z.object({
  mode: z.enum(["course", "extension", "revision"]), targetLanguage: z.enum(["en", "de"]).nullable().optional(), idea: text(20000), title: text(200), age: z.number().int().min(7).max(18), grade: z.number().int().min(1).max(12),
  lessonCount: z.number().int().safe().min(1), minutes: z.number().int().min(10).max(45), budgetUsd: z.number().min(0.5).max(STUDIO_MAX_BUDGET),
  subjectId: z.string().uuid().nullable(), topicId: z.string().uuid().nullable(), materialId: z.string().uuid().nullable(),
  pageFrom: z.number().int().min(1).max(10000).nullable(), pageTo: z.number().int().min(1).max(10000).nullable(), sourceText: z.string().max(40000),
}).strict().superRefine((value, ctx) => {
  if (["extension", "revision"].includes(value.mode) && (!value.subjectId || !value.topicId || value.lessonCount !== 1)) ctx.addIssue({ code: "custom", message: "Для розширення обери предмет і базовий урок; готуємо один розширений урок." });
  if ((value.pageFrom === null) !== (value.pageTo === null) || (value.pageFrom !== null && value.pageTo !== null && (value.pageTo < value.pageFrom))) ctx.addIssue({ code: "custom", message: "Укажи обидві межі діапазону; кінцева сторінка має бути не меншою за початкову." });
});
export type StudioRequest = z.infer<typeof studioRequestSchema>;
export const studioPlanSchema = z.object({ title: text(200), overview: text(3000), objectives: z.array(text(250)).min(1).max(8), lessons: z.array(z.object({ title: text(200), goal: text(700), topics: z.array(text(200)).max(24).optional(), sourceIds: z.array(text(100)).max(STUDIO_MAX_SOURCE_CHUNKS).optional() }).strict()).min(1), prerequisites: z.array(text(250)).max(8), limitations: z.array(text(500)).max(8), sourceExclusions: z.array(z.object({ sourceId: text(100), reason: text(500) }).strict()).max(200).optional() }).strict();
export const studioPlanBatchSchema = studioPlanSchema.extend({ lessons: studioPlanSchema.shape.lessons.max(STUDIO_PLAN_BATCH_SIZE) });
export type StudioPlan = z.infer<typeof studioPlanSchema>;
export const studioLessonSchema = z.object({ title: text(200), objectives: z.array(text(250)).min(1).max(6),
  blocks: z.array(z.object({ title: text(150), kind: z.enum(["explanation", "example", "practice", "steps", "summary", "code"]), text: text(8000), narration: text(12000), narrationLanguage: z.enum(["uk-UA", "en-GB", "de-DE"]).nullable().optional() }).strict()).min(3).max(STUDIO_MAX_BLOCKS),
  questions: z.array(z.object({ prompt: text(800), options: z.array(text(400)).length(3), correctIndex: z.number().int().min(0).max(2), explanation: text(1200) }).strict()).min(2).max(STUDIO_MAX_QUIZZES),
  sourceIds: z.array(text(100)).max(STUDIO_MAX_SOURCE_CHUNKS), enrichmentNote: text(1000), adultAssistance: z.string().max(1500),
}).strict();
export type StudioLesson = z.infer<typeof studioLessonSchema>;
/** Avoid paying for a duplicate Ukrainian narration; the server derives the full spoken text. */
export const studioAuthorSchema = studioLessonSchema.extend({ blocks: z.array(studioLessonSchema.shape.blocks.element.extend({ narration: z.string().trim().max(12000).nullable() })).min(3).max(STUDIO_MAX_BLOCKS) });
export const studioVisualSchema = z.object({ blockIndex: z.number().int().min(0).max(STUDIO_MAX_BLOCKS - 1), kind: z.enum(["sequence", "comparison", "timeline", "dimensions"]), title: text(120), items: z.array(z.object({ label: text(240), detail: text(600) }).strict()).min(2).max(5), width: z.number().positive().max(10000).nullable(), height: z.number().positive().max(10000).nullable(), unit: z.enum(["мм", "см", "м", ""]), caption: text(500) }).strict();
export type StudioVisual = z.infer<typeof studioVisualSchema>;
export const STUDIO_MAX_VISUALS = 16;
export const studioDesignSchema = z.object({ visuals: z.array(studioVisualSchema).max(STUDIO_MAX_VISUALS) }).strict();
export const studioCorrectionSchema = z.object({
  role: z.enum(["author", "design"]),
  blockIndex: z.number().int().min(0).max(STUDIO_MAX_BLOCKS - 1).nullable(),
  visualIndex: z.number().int().min(0).max(STUDIO_MAX_VISUALS - 1).nullable(),
  problem: text(500), action: text(1000), acceptance: text(700),
}).strict();
export const studioReviewSchema = z.object({ verdict: z.enum(["pass", "revise", "reject"]), issues: z.array(text(1000)).max(12), summary: text(2000), corrections: z.array(studioCorrectionSchema).max(12).optional() }).strict();
/** Required for new model calls; older saved reviews remain readable. */
export const studioReviewResponseSchema = studioReviewSchema.extend({ corrections: z.array(studioCorrectionSchema).max(12) });
export type StudioReview = z.infer<typeof studioReviewSchema>;
export interface StudioSource { id: string; title: string; text: string; page: number | null; kind: "lesson" | "book" | "provided" | "summary"; audience?: "learner" | "teacher" | "reference"; evidenceWarnings?: string[]; }
export interface StudioIllustration { id: string; blockIndex: number; title: string; caption: string; sourceUrl: string; credit: string; license: string; storagePath: string; byteSize: number; }
export interface StudioBaseTopic { id: string; subjectId: string; title: string; pageFrom: number | null; pageTo: number | null; href?: string; }
export interface StudioSourceSelection { candidates: StudioBaseTopic[]; fallbackMaterialId: string | null; selectedIds: string[]; assessed: boolean; reason?: string; }
export interface StudioSourceContext { rawParts?: number[]; noteRefs?: string[]; ids: string[]; }
export interface StudioSourceCorpus {
  id: string; partCount: number; chunkCount: number; characterCount: number; blankChunks: number; pageFrom: number | null; pageTo: number | null;
  analysisContract?: string;
  analyzed: number; notes: string[]; catalog: string[]; reduceCursor: number; reduced: string[];
}
export interface StudioLessonSources { recoverySlice?: number; targetPhase: "author" | "design" | "review" | "repair"; lessonIndex: number; partIndexes: number[]; cursor: number; notes: string[]; catalog: string[]; reduceCursor: number; reduced: string[]; context?: StudioSourceContext; }
export interface StudioUnit { sourceContext?: StudioSourceContext; illustrations?: StudioIllustration[]; content: StudioLesson; visuals: StudioVisual[]; review: StudioReview | null; reviewRound?: number; lastReviewFingerprint?: string | null; }
export type StudioState = "planning" | "plan_ready" | "generating" | "ready" | "needs_changes" | "failed" | "paused" | "publishing" | "published" | "withdrawn";
export interface StudioPendingModelCall { background?: { id: string; started: number; observation?: StudioProviderObservation; model: string; role: string; rates: import("../server/ai/types").ModelPrice }; id: string; phase: StudioProject["phase"]; cursor: number; inputHash: string; reservedUsd: number; billed: boolean; }
export interface StudioFailureDiagnostic { evidence?: "provider_audit"; provider?: string; status?: number; phase: StudioProject["phase"]; code: string; paths: string[]; category: "content" | "processing"; at: string; }
export interface StudioProject {
  autonomous?: boolean;
  unavailableSpecialists?: string[];
  lastTransportRetryHash?: string;
  lastRateLimitRetryHash?: string;
  pendingModelCall?: StudioPendingModelCall;
  unresolvedModelCalls?: StudioPendingModelCall[];
  regeneration?: { pending: StudioPendingModelCall; diagnostic: StudioFailureDiagnostic };
  failureDiagnostic?: StudioFailureDiagnostic;
  repairPart?: number;
  savedModelResult?: boolean;
  canRegenerate?: boolean;
  canRestart?: boolean;
  version: 1; revision: number;
  /** Immutable backing documents; omitted from parent responses. */
  unitRefs?: string[];
  sourceCorpus?: StudioSourceCorpus;
  sourceSelection?: StudioSourceSelection;
  lessonSources?: StudioLessonSources;
  /** Public progress only; private corpus state is removed from parent responses. */
  sourceProgress?: { partCount: number; analyzed: number; characters: number; stage: string; lessonParts: number; lessonPrepared: number };
  /** Parent response contains full content only for this preview index. */
  previewIndex?: number;
  /** Draft corrections over an existing publication; child content changes only on republish. */
  publicationRevision?: boolean;
  revisionRequestId?: string;
  childAccess?: "enabled" | "disabled";
  /** Explicit parent-requested review: never auto-start author/design after its verdict. */
  reviewOnly?: boolean;
  reviewAutomationStopped?: boolean;
  reviewRepairAttempted?: boolean;
  consecutiveReviewFailures?: number;
  repairAdvice?: string;
  revisionInstructions?: string;
  editorNotes?: { at: string; lessonIndex: number; text: string }[];
  request: StudioRequest; state: StudioState; createdAt: string;
  sources: StudioSource[]; sourceNotes: string[]; subjectName: string | null; baseHref: string | null; baseTitle: string | null;
  plan: StudioPlan | null; units: StudioUnit[]; cursor: number; phase: "resolve" | "assess" | "analyze" | "outline" | "lesson_sources" | "lesson_outline" | "plan" | "author" | "design" | "review" | "repair" | "publish";
  token: string; activeCall: boolean; spentUsd: number; heldUsd: number; feedback: string; error: string | null;
  models: { role: string; model: string; costUsd: number }[];
  publication: { subjectId: string; packageId: string; lessons: { id: string; topicId: string; title: string }[] } | null;
}
export const studioStateLabels: Record<StudioState, string> = { planning: "Готуємо план", plan_ready: "План готовий", generating: "Готуємо уроки", ready: "Готово до перегляду", needs_changes: "Потрібні виправлення", failed: "Етап не завершено", paused: "Призупинено татом", publishing: "Публікуємо", published: "Доступно дитині", withdrawn: "Доступ вимкнено" };
export function studioActive(state: StudioState) { return ["planning", "generating", "publishing"].includes(state); }

/** Read-only queue observation returned to the authenticated parent, not a claim of provider progress. */
export interface StudioProviderObservation { status: "queued" | "in_progress"; at: number }
export interface StudioActivity {
  providerObservation?: StudioProviderObservation;
  queue: "queued" | "running" | "finished" | "interrupted" | "unavailable" | "none";
  checkedAt: string;
  backgroundStartedAt?: number;
  runAfter?: string | null;
}

/** Legacy publications predate an explicit visibility flag. */
export function studioPublicationVisible(project: Pick<StudioProject, "publication" | "state" | "publicationRevision" | "childAccess">): boolean {
  return !!project.publication && (project.childAccess ? project.childAccess === "enabled" : project.state === "published" || (project.publicationRevision === true && project.state !== "withdrawn"));
}

export interface StudioReviewEvent { at: string; lessonIndex: number; round: number; review: StudioReview; next: "author" | "design" | "repair" | "ready" | "stopped" | "parent"; }

/** Old no-progress stops get one automatic diagnostic repair, without restarting failed/paused/uncertain jobs. */
export function studioCanResumeIncompleteRepair(project: StudioProject) {
  return project.state === "failed" && project.phase === "repair" && !project.activeCall && !project.reviewOnly
    && project.failureDiagnostic?.code === "STUDIO-AI-INCOMPLETE" && project.repairPart === undefined
    && !!(project.pendingModelCall?.billed || project.savedModelResult) && !!project.units[project.cursor]?.review;
}

export function studioCanAutoResumeReview(project: Pick<StudioProject, "state" | "activeCall" | "reviewAutomationStopped" | "reviewRepairAttempted" | "error">) {
  return project.state === "needs_changes" && !project.activeCall && (!project.reviewAutomationStopped || (!project.reviewRepairAttempted && !!project.error?.startsWith("STUDIO-NO-PROGRESS")));
}
