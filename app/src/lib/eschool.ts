import { z } from "zod";
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }, "Невірна дата");
export const schoolIdentitySchema = z.object({ schoolId: z.number().int().positive().safe(), pupilId: z.number().int().positive().safe(), classLabel: z.string().max(40) }).strict();
export const schoolSourceSchema = z.object({
  externalId: z.string().regex(/^(lesson:\d+|homework:\d+|topic:\d+:\d+)$/).max(100), kind: z.enum(["lesson", "homework"]), appointmentId: z.number().int().positive().safe(), subjectExternalId: z.number().int().positive().safe().nullable(),
  subject: z.string().trim().min(1).max(180), lessonDate: calendarDate, dueDate: calendarDate.nullable(), topic: z.string().max(2500), text: z.string().max(16000), attachments: z.number().int().min(0).max(1000), cancelled: z.boolean(),
}).strict();
export type SchoolSource = z.infer<typeof schoolSourceSchema>;
export const schoolPacketSchema = z.object({ schemaVersion: z.literal(1), packetId: z.string().uuid(), capturedAt: z.iso.datetime(), identity: schoolIdentitySchema, range: z.object({ start: calendarDate, end: calendarDate }).strict(), entries: z.array(schoolSourceSchema).max(400), complete: z.boolean(), warnings: z.array(z.string().max(200)).max(150) }).strict().superRefine((packet, ctx) => {
  const days = (Date.parse(packet.range.end) - Date.parse(packet.range.start)) / 86400000;
  if (days < 0 || days > 13) ctx.addIssue({ code: "custom", message: "Обери до 14 днів." });
  if (new Set(packet.entries.map(entry => entry.externalId)).size !== packet.entries.length) ctx.addIssue({ code: "custom", message: "Пакет містить дублікати записів." });
});
export type SchoolPacket = z.infer<typeof schoolPacketSchema>;
export type SchoolStatus = "todo" | "working" | "prepared" | "done";
export const schoolStatusLabels: Record<SchoolStatus, string> = { todo: "Потрібно зробити", working: "У роботі", prepared: "Підготовлено", done: "Виконано" };
export interface SchoolEntry { version: 1; revision: number; childId: string; identity: SchoolPacket["identity"]; source: SchoolSource; capturedAt: string; syncedAt: string; status: SchoolStatus; changed: boolean; subjectId: string | null; topicId: string | null; lessonHref: string | null; workHref: string | null; }
export interface SchoolEntryView { id: string; entry: SchoolEntry; }
export interface SchoolConnection { version: 1; revision: number; childId: string; identity: SchoolPacket["identity"] | null; lastSync: string | null; lastCapturedAt: string | null; lastPacketId: string | null; range: SchoolPacket["range"] | null; count: number; warnings: string[]; lock: { token: string; at: string } | null; }
export function schoolToday(now = new Date()): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kiev", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
export function schoolDue(source: SchoolSource, status: SchoolStatus, today = schoolToday()): string | null {
  if (source.kind !== "homework" || status === "done") return null;
  return source.dueDate ? source.dueDate < today ? "Термін минув" : source.dueDate === today ? "На сьогодні" : "Незабаром" : "Термін не вказано";
}
export function normalizedSchoolSubject(value: string) { return value.toLocaleLowerCase("uk").replace(/[’'ʼ`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
