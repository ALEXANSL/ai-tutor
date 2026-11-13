import { z } from "zod";
export const chapterSchema = z.object({ title: z.string().trim().min(1).max(200), from: z.number().int().min(1).max(20000), to: z.number().int().min(1).max(20000) }).refine(c => c.to >= c.from, "Перевір діапазон розділу.");
export const librarySettingsSchema = z.object({ author: z.string().trim().max(200), printedOffset: z.number().int().min(-1000).max(1000), printedConfirmed: z.boolean(), chaptersOverride: z.boolean().optional(), chapters: z.array(chapterSchema).max(500) });
export type LibrarySettings = z.infer<typeof librarySettingsSchema>;
export const audioRequestSchema = z.object({ materialId: z.string().uuid(), paragraphId: z.string().uuid().optional(), lesson: z.object({ kind: z.enum(["explanation", "reading"]).optional(), subjectId: z.string().uuid(), topicId: z.string().uuid() }).strict().optional(), title: z.string().trim().min(1).max(200), from: z.number().int().min(1).max(20000), to: z.number().int().min(1).max(20000), numbering: z.enum(["source", "printed"]), budgetUsd: z.number().min(0.5).max(25), voice: z.enum(["nova", "alloy", "onyx"]), preserveLines: z.boolean(), retainPrepared: z.literal(true) }).strict().refine(v => v.to >= v.from && v.to - v.from < 50, "Обери від 1 до 50 сторінок/розділів.").refine(v => !v.lesson || (!v.paragraphId && v.materialId === v.lesson.subjectId && v.from === 1 && v.to === 1 && v.numbering === "source"), "Для аудіоуроку обери готовий урок предмета.");
export type AudioRequest = z.infer<typeof audioRequestSchema>;
export const exclusionSchema = z.object({ omitted: z.array(z.object({ id: z.number().int().nonnegative(), reason: z.enum(["page_number", "running_header", "illustration_caption", "index_entry"]) }).strict()).max(500), notes: z.string().max(1500) }).strict();
export type AudioParagraph = { id: number; page: number; text: string };
export type AudioPart = {
  version: 1; revision: number; request: AudioRequest; bookTitle: string; author: string; format: string; sourceFrom: number; sourceTo: number;
  createdAt: string; state: "preparing" | "draft" | "generating" | "ready" | "paused" | "failed" | "deleting" | "deleted";
  phase: "prepare" | "audio"; published: boolean; token: string; leaseUntil: number; activeCall: boolean;
  paragraphs: AudioParagraph[]; omitted: z.infer<typeof exclusionSchema>["omitted"]; notes: string; manuscript: string;
  sourceHash: string; segmentCount: number; readyCount: number; segments: { text: string; key: string; ready: boolean }[]; spentUsd: number; heldUsd: number;
  error: string | null; receipts: { role: string; model: string; costUsd: number }[];
};
export type AudioCard = { lessonKind?: "explanation" | "reading" | null; lessonTopicId?: string | null; id: string; materialId: string; title: string; bookTitle: string; state: AudioPart["state"]; published: boolean; ready: number; total: number; from: number; to: number; createdAt: string };
export type LibraryBook = { id: string; title: string; author: string; format: string; pages: number | null; paragraphs?: { id: string; title: string; from: number; to: number }[]; chapters: LibrarySettings["chapters"]; settings: LibrarySettings };
export const audioRunning = (p: AudioPart) => p.state === "preparing" || p.state === "generating";
