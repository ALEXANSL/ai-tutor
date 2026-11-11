import { z } from "zod";
import type { VoiceTarget } from "./voice";
const text = (max: number) => z.string().trim().min(1).max(max);
export const homeworkFormatSchema = z.enum(["chat", "docx", "pptx"]);
export type HomeworkFormat = z.infer<typeof homeworkFormatSchema>;
export const homeworkResultSchema = z.object({
  message: text(24000),
  artifact: z.object({
    title: text(180), subtitle: z.string().max(300),
    sections: z.array(z.object({ heading: text(180), paragraphs: z.array(text(2400)).min(1).max(8) }).strict()).max(20),
    slides: z.array(z.object({ title: text(120), bullets: z.array(text(500)).min(1).max(8), notes: z.string().max(1800) }).strict()).max(24),
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
