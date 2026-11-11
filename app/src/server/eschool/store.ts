import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import type { SchoolConnection, SchoolEntry } from "@/lib/eschool";
export const SCHOOL_CONNECTION = "eschool.connection";
export const SCHOOL_ENTRY = "eschool.entry";
export function schoolId(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16); bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function readSchoolDoc<T extends SchoolConnection | SchoolEntry>(familyId: string, childId: string, id: string, type: string): Promise<T | null> {
  const result = await forFamily(familyId).select("jobs", "payload").eq("id", id).eq("type", type).eq("payload->>childId", childId).maybeSingle<{ payload: T }>();
  if (result.error) throw new Error("Не вдалося прочитати щоденник."); return result.data?.payload?.version === 1 ? result.data.payload : null;
}
export async function createSchoolDoc(familyId: string, id: string, type: string, payload: SchoolConnection | SchoolEntry) {
  const { error } = await forFamily(familyId).insert("jobs", { id, type, status: "done", payload });
  if (error?.code === "23505") return false;
  if (error) throw new Error("Не вдалося зберегти запис щоденника."); return true;
}
export async function saveSchoolDoc<T extends SchoolConnection | SchoolEntry>(familyId: string, id: string, type: string, previous: T, changes: Partial<T>): Promise<T> {
  const next = { ...previous, ...changes, revision: previous.revision + 1 };
  const { data, error } = await forFamily(familyId).update("jobs", { payload: next }).eq("id", id).eq("type", type).eq("payload->>childId", previous.childId).eq("payload->>revision", String(previous.revision)).select("id").maybeSingle<{ id: string }>();
  if (error || !data) throw new Error("Запис уже змінено. Онови щоденник і повтори дію."); return next;
}
export async function readSchoolConnection(familyId: string, childId: string) {
  const id = schoolId(SCHOOL_CONNECTION, familyId, childId);
  const connection = await readSchoolDoc<SchoolConnection>(familyId, childId, id, SCHOOL_CONNECTION);
  return { id, connection };
}
export async function listSchoolEntries(familyId: string, childId: string) {
  const { data, error } = await forFamily(familyId).select("jobs", "id,payload").eq("type", SCHOOL_ENTRY).eq("payload->>childId", childId).order("created_at", { ascending: false }).limit(501).returns<{ id: string; payload: SchoolEntry }[]>();
  if (error) throw new Error("Не вдалося завантажити уроки й ДЗ.");
  return { limited: (data?.length ?? 0) > 500, entries: (data ?? []).slice(0, 500).filter(row => row.payload?.version === 1).map(row => ({ id: row.id, entry: row.payload })) };
}
