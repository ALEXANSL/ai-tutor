import { z } from "zod";
import type { VoiceTarget } from "./voice";
const text = (max: number) => z.string().trim().min(1).max(max);
export const homeworkFormatSchema = z.enum(["chat", "docx", "pptx"]);
export type HomeworkFormat = z.infer<typeof homeworkFormatSchema>;
export const homeworkTableSchema = z.object({ title: text(140), columns: z.array(text(80)).min(2).max(5), rows: z.array(z.array(text(250)).min(2).max(5)).min(1).max(8) }).strict();
export const homeworkVisualSchema = z.object({ kind: z.enum(["sequence", "comparison", "timeline", "chart", "concept"]), title: text(140), caption: text(500), unit: z.string().max(30), items: z.array(z.object({ label: text(70), detail: z.string().max(180), value: z.number().finite().nullable() }).strict()).min(2).max(5) }).strict();
export type HomeworkVisual = z.infer<typeof homeworkVisualSchema>;
export type HomeworkTable = z.infer<typeof homeworkTableSchema>;
export const homeworkResultSchema = z.object({
  message: text(24000),
  quality: z.object({ status: z.enum(["ready", "draft"]), issues: z.array(z.string()).max(20) }).optional(),
  artifact: z.object({
    title: text(180), subtitle: z.string().max(300), unresolvedRequirements: z.array(text(500)).max(8).optional(),
    sections: z.array(z.object({ heading: text(180), paragraphs: z.array(text(2400)).min(1).max(8), tables: z.array(homeworkTableSchema).max(3).optional(), visuals: z.array(homeworkVisualSchema).max(3).optional() }).strict()).max(20),
    slides: z.array(z.object({ title: text(120), bullets: z.array(text(500)).min(1).max(8), notes: z.string().max(2500), table: homeworkTableSchema.nullable().optional(), visual: homeworkVisualSchema.nullable().optional() }).strict()).max(24),
    studyTips: z.array(text(500)).max(6),
  }).strict().nullable(),
}).strict();
export type HomeworkResult = z.infer<typeof homeworkResultSchema>;
export interface HomeworkTurn { requestId: string; question: string; format: HomeworkFormat; pages: number[]; files: string[]; answer: string | null; at: string; }
export interface HomeworkWork {
  version: 1; revision: number; assignmentId?: string; childId: string; lessonKey: string; target: VoiceTarget;
  title: string; lessonTitle: string; backHref: string; context: string; subject: string; topic: string;
  createdAt: string; updatedAt: string; state: "running" | "ready" | "failed"; activeRequestId: string | null;
  turns: HomeworkTurn[]; result: HomeworkResult | null; format: HomeworkFormat; error: string | null;
}
export interface HomeworkView { id: string; work: Omit<HomeworkWork, "context" | "childId">; }
export function homeworkView(id: string, value: HomeworkWork): HomeworkView {
  const work = { ...value } as Partial<HomeworkWork>; delete work.context; delete work.childId;
  return { id, work: work as HomeworkView["work"] };
}
export function homeworkHref(target: VoiceTarget): string { return `/homework?target=${encodeURIComponent(JSON.stringify(target))}`; }

/** New generations require the fields; stored text-only works stay readable. */
const artifactShape = homeworkResultSchema.shape.artifact.unwrap();
export const homeworkGenerationSchema = homeworkResultSchema.omit({ quality: true }).extend({ artifact: artifactShape.extend({ unresolvedRequirements: z.array(text(500)).max(8), sections: z.array(artifactShape.shape.sections.element.extend({ tables: z.array(homeworkTableSchema).max(3), visuals: z.array(homeworkVisualSchema).max(3) })).max(20), slides: z.array(artifactShape.shape.slides.element.extend({ table: homeworkTableSchema.nullable(), visual: homeworkVisualSchema.nullable() })).max(24) }).nullable() });
