import { z } from "zod";
const text = (max = 4000) => z.string().trim().min(1).max(max);
export const studioRequestSchema = z.object({
  mode: z.enum(["course", "extension"]), idea: text(20000), title: text(200), age: z.number().int().min(7).max(18), grade: z.number().int().min(1).max(12),
  lessonCount: z.number().int().min(1).max(6), minutes: z.number().int().min(10).max(45), budgetUsd: z.number().min(0.5).max(25),
  subjectId: z.string().uuid().nullable(), topicId: z.string().uuid().nullable(), materialId: z.string().uuid().nullable(),
  pageFrom: z.number().int().min(1).max(10000).nullable(), pageTo: z.number().int().min(1).max(10000).nullable(), sourceText: z.string().max(40000),
}).strict().superRefine((value, ctx) => {
  if (value.mode === "extension" && (!value.subjectId || !value.topicId || value.lessonCount !== 1)) ctx.addIssue({ code: "custom", message: "Для розширення обери предмет і базовий урок; готуємо один розширений урок." });
  if ((value.pageFrom === null) !== (value.pageTo === null) || (value.pageFrom !== null && value.pageTo !== null && (value.pageTo < value.pageFrom || value.pageTo - value.pageFrom > 30))) ctx.addIssue({ code: "custom", message: "Вибери послідовний діапазон до 31 сторінки." });
});
export type StudioRequest = z.infer<typeof studioRequestSchema>;
export const studioPlanSchema = z.object({ title: text(200), overview: text(3000), objectives: z.array(text(250)).min(1).max(8), lessons: z.array(z.object({ title: text(200), goal: text(700) }).strict()).min(1).max(6), prerequisites: z.array(text(250)).max(8), limitations: z.array(text(500)).max(8) }).strict();
export type StudioPlan = z.infer<typeof studioPlanSchema>;
export const studioLessonSchema = z.object({ title: text(200), objectives: z.array(text(250)).min(1).max(6),
  blocks: z.array(z.object({ title: text(150), kind: z.enum(["explanation", "example", "practice", "steps", "summary", "code"]), text: text(4500), narration: text(3500) }).strict()).min(4).max(8),
  questions: z.array(z.object({ prompt: text(800), options: z.array(text(400)).length(3), correctIndex: z.number().int().min(0).max(2), explanation: text(1200) }).strict()).min(2).max(3),
  sourceIds: z.array(text(100)).max(30), enrichmentNote: text(1000), adultAssistance: z.string().max(1500),
}).strict();
export type StudioLesson = z.infer<typeof studioLessonSchema>;
export const studioVisualSchema = z.object({ blockIndex: z.number().int().min(0).max(7), kind: z.enum(["sequence", "comparison", "timeline", "dimensions"]), title: text(120), items: z.array(z.object({ label: text(50), detail: text(110) }).strict()).min(2).max(5), width: z.number().positive().max(10000).nullable(), height: z.number().positive().max(10000).nullable(), unit: z.enum(["мм", "см", "м", ""]), caption: text(500) }).strict();
export type StudioVisual = z.infer<typeof studioVisualSchema>;
export const studioDesignSchema = z.object({ visuals: z.array(studioVisualSchema).min(1).max(2) }).strict();
export const studioReviewSchema = z.object({ verdict: z.enum(["pass", "revise", "reject"]), issues: z.array(text(1000)).max(12), summary: text(2000) }).strict();
export type StudioReview = z.infer<typeof studioReviewSchema>;
export interface StudioSource { id: string; title: string; text: string; page: number | null; kind: "lesson" | "book" | "provided"; }
export interface StudioUnit { content: StudioLesson; visuals: StudioVisual[]; review: StudioReview | null; }
export type StudioState = "planning" | "plan_ready" | "generating" | "ready" | "needs_changes" | "failed" | "paused" | "publishing" | "published" | "withdrawn";
export interface StudioProject {
  version: 1; revision: number; request: StudioRequest; state: StudioState; createdAt: string;
  sources: StudioSource[]; sourceNotes: string[]; subjectName: string | null; baseHref: string | null; baseTitle: string | null;
  plan: StudioPlan | null; units: StudioUnit[]; cursor: number; phase: "plan" | "author" | "design" | "review" | "publish";
  token: string; activeCall: boolean; spentUsd: number; heldUsd: number; feedback: string; error: string | null;
  models: { role: string; model: string; costUsd: number }[];
  publication: { subjectId: string; packageId: string; lessons: { id: string; topicId: string; title: string }[] } | null;
}
export const studioStateLabels: Record<StudioState, string> = { planning: "Готуємо план", plan_ready: "План готовий", generating: "Готуємо уроки", ready: "Готово до перегляду", needs_changes: "Потрібні виправлення", failed: "Етап не завершено", paused: "Призупинено татом", publishing: "Публікуємо", published: "Доступно дитині", withdrawn: "Доступ вимкнено" };
export function studioActive(state: StudioState) { return ["planning", "generating", "publishing"].includes(state); }

/** Read-only queue observation returned to the authenticated parent, not a claim of provider progress. */
export interface StudioActivity {
  queue: "queued" | "running" | "finished" | "interrupted" | "unavailable" | "none";
  checkedAt: string;
  runAfter?: string | null;
}
