import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import { schoolId } from "./store";
import type { SchoolEntry } from "@/lib/eschool";
import { importedLessonHref, type ImportedLessonSelectors } from "@/lib/imported-lesson-link";
type ContextTopic = ImportedLessonSelectors & { id: string; title: string; pageFrom?: number | null; pageTo?: number | null };
export const CONTEXT_TYPE = "eschool.context.v1";
export interface ContextResult { state: "pending" | "done" | "failed"; topicId: string | null; reason: string; confidence: number; matches?: { topicId: string; reason: string }[]; }
export interface ContextRecord extends ContextResult { childId: string; createdAt: string; }
export function contextMatchId(familyId: string, childId: string, subjectId: string, entry: SchoolEntry, topics: readonly ContextTopic[]) {
  const digest = createHash("sha256").update(JSON.stringify({ topic: entry.source.topic, text: entry.source.text, subject: entry.source.subject, topics: topics.map(topic => [topic.id, topic.title, topic.pageFrom, topic.pageTo, importedLessonHref(topic)]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))) })).digest("hex");
  // A daily window also invalidates edits to lesson bodies with stable IDs.
  return schoolId(CONTEXT_TYPE, familyId, childId, subjectId, digest, new Date().toISOString().slice(0, 10));
}
export async function readContextMatch(familyId: string, childId: string, id: string): Promise<ContextRecord | null> {
  const { data, error } = await forFamily(familyId).select("jobs", "payload").eq("id", id).eq("type", CONTEXT_TYPE).eq("payload->>childId", childId).maybeSingle<{ payload: ContextRecord }>();
  if (error) throw new Error("Не вдалося прочитати результат пошуку. Онови сторінку пізніше.");
  const record = data?.payload ?? null;
  if (record?.state === "pending" && Date.now() - Date.parse(record.createdAt) > 180000) return { ...record, state: "failed", reason: "Попередній пошук не завершився. Можна обрати урок зі списку або зберегти прив’язку в батьківському щоденнику." };
  return record;
}
export async function claimContextMatch(familyId: string, id: string, childId: string): Promise<boolean> {
  const record: ContextRecord = { childId, createdAt: new Date().toISOString(), state: "pending", topicId: null, reason: "", confidence: 0 };
  const { error } = await forFamily(familyId).insert("jobs", { id, type: CONTEXT_TYPE, status: "done", payload: record });
  if (error?.code === "23505") return false;
  if (error) throw new Error("Не вдалося запустити пошук уроку. Онови сторінку пізніше."); return true;
}
export async function finishContextMatch(familyId: string, id: string, childId: string, result: ContextResult) {
  const { data, error } = await forFamily(familyId).update("jobs", { payload: { ...result, childId, createdAt: new Date().toISOString() } }).eq("id", id).eq("type", CONTEXT_TYPE).eq("payload->>childId", childId).eq("payload->>state", "pending").select("id").maybeSingle<{ id: string }>();
  if (error || !data) throw new Error("Не вдалося зберегти результат пошуку. Онови сторінку пізніше.");
}
