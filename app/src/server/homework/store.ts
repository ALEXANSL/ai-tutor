import "server-only";
import { forFamily } from "@/server/db/family-scope";
import type { HomeworkWork } from "@/lib/homework";
export const HOMEWORK_WORK = "homework.work";
export async function readHomework(familyId: string, childId: string, id: string): Promise<HomeworkWork | null> {
  const { data, error } = await forFamily(familyId).select("jobs", "payload").eq("id", id).eq("type", HOMEWORK_WORK).eq("payload->>childId", childId).maybeSingle<{ payload: HomeworkWork }>();
  if (error) throw new Error("Не вдалося відкрити роботу.");
  return data?.payload?.version === 1 ? data.payload : null;
}
export async function createHomework(familyId: string, id: string, work: HomeworkWork) {
  const { error } = await forFamily(familyId).insert("jobs", { id, type: HOMEWORK_WORK, status: "done", payload: work });
  if (error) throw new Error("Не вдалося зберегти роботу. Онови список перед повтором.");
}
export async function saveHomework(familyId: string, id: string, previous: HomeworkWork, changes: Partial<HomeworkWork>) {
  const next = { ...previous, ...changes, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(next)) > 1000000) throw new Error("Діалог завеликий. Почни нову роботу; попередню збережено.");
  const { data, error } = await forFamily(familyId).update("jobs", { payload: next }).eq("id", id).eq("type", HOMEWORK_WORK).eq("payload->>childId", previous.childId).eq("payload->>revision", String(previous.revision)).select("id").maybeSingle<{ id: string }>();
  if (error || !data) throw new Error("Роботу вже змінено. Онови її перед наступним запитом.");
  return next;
}
export async function listHomework(familyId: string, childId: string, lessonKey: string) {
  const { data, error } = await forFamily(familyId).select("jobs", "id,payload").eq("type", HOMEWORK_WORK).eq("payload->>childId", childId).eq("payload->>lessonKey", lessonKey).order("created_at", { ascending: false }).limit(50).returns<{ id: string; payload: HomeworkWork }[]>();
  if (error) throw new Error("Не вдалося завантажити роботи.");
  return (data ?? []).filter(row => row.payload?.version === 1);
}
