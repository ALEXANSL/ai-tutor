import "server-only";
import { audioHash } from "./text";
import { forFamily } from "@/server/db/family-scope";
import type { AudioPart, AudioCard, LibrarySettings } from "@/lib/audiobooks";
export const PART_TYPE = "audiobook.part";
export const SETTINGS_TYPE = "audiobook.book";
export function documentId(key: string) { const h = audioHash(key); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; }
export async function readAudioPart(familyId: string, id: string): Promise<AudioPart | null> {
  const { data, error } = await forFamily(familyId).select("jobs", "payload").eq("id", id).eq("type", PART_TYPE).maybeSingle<{ payload: AudioPart }>();
  if (error) throw new Error("Не вдалося прочитати аудіокнигу."); return data?.payload?.version === 1 ? data.payload : null;
}
export async function insertAudioPart(familyId: string, id: string, part: AudioPart) {
  const { error } = await forFamily(familyId).insert("jobs", { id, type: PART_TYPE, status: "done", payload: part });
  if (error?.code === "23505") { const current = await readAudioPart(familyId, id); if (current && JSON.stringify(current.request) === JSON.stringify(part.request)) return false; }
  if (error) throw new Error("Не вдалося створити підготовку. Онови сторінку."); return true;
}
export async function saveAudioPart(familyId: string, id: string, previous: AudioPart, changes: Partial<AudioPart>) {
  const next = { ...previous, ...changes, revision: previous.revision + 1 };
  next.segmentCount = next.segments.length; next.readyCount = next.segments.filter(s => s.ready).length;
  if (Buffer.byteLength(JSON.stringify(next)) > 900000) throw new Error("Обсяг завеликий для однієї частини книги.");
  const { data, error } = await forFamily(familyId).update("jobs", { payload: next }).eq("id", id).eq("type", PART_TYPE).eq("payload->>revision", String(previous.revision)).select("id").maybeSingle();
  if (error || !data) throw new Error("Стан уже змінився. Онови сторінку перед повтором."); return next;
}
export async function listAudioCards(familyId: string, materialId?: string, publishedOnly = false): Promise<AudioCard[]> {
  let query = forFamily(familyId).select("jobs", "id,materialId:payload->request->>materialId,title:payload->request->>title,bookTitle:payload->>bookTitle,state:payload->>state,published:payload->>published,ready:payload->>readyCount,total:payload->>segmentCount,from:payload->>sourceFrom,to:payload->>sourceTo,createdAt:payload->>createdAt").eq("type", PART_TYPE).neq("payload->>state", "deleted");
  if (materialId) query = query.eq("payload->request->>materialId", materialId);
  if (publishedOnly) query = query.eq("payload->>published", "true").eq("payload->>state", "ready");
  const rows: unknown[] = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const { data, error } = await query.order("created_at", { ascending: false }).order("id").range(offset, offset + 499);
    if (error) throw new Error("Не вдалося прочитати аудіотеку.");
    rows.push(...(data ?? [])); if (!data || data.length < 500) break;
    if (offset === 9500) throw new Error("Аудіотека завелика для цього перегляду.");
  }
  // Explicit projection below never returns source/manuscript/audio storage keys to a catalog client.
  return rows.map(row => { const r = row as unknown as { id: string; materialId: string; title: string; bookTitle: string; state: AudioPart["state"]; published: string; ready: string; total: string; from: string; to: string; createdAt: string }; return { ...r, published: r.published === "true", ready: Number(r.ready || 0), total: Number(r.total || 0), from: Number(r.from), to: Number(r.to) }; });
}
export const defaultLibrarySettings: LibrarySettings = { author: "", printedOffset: 0, printedConfirmed: false, chapters: [] };
export async function readLibrarySettings(familyId: string, materialId: string): Promise<LibrarySettings> {
  const { data, error } = await forFamily(familyId).select("jobs", "payload").eq("id", documentId(`${familyId}:library:${materialId}`)).eq("type", SETTINGS_TYPE).maybeSingle<{ payload: LibrarySettings }>();
  if (error) throw new Error("Не вдалося прочитати налаштування книги."); return data?.payload ?? defaultLibrarySettings;
}
export async function saveLibrarySettings(familyId: string, materialId: string, payload: LibrarySettings) {
  // Deterministic family-owned ID; never accepts a client-controlled foreign document ID.
  const { error } = await forFamily(familyId).upsert("jobs", { id: documentId(`${familyId}:library:${materialId}`), type: SETTINGS_TYPE, status: "done", payload }, "id");
  if (error) throw new Error("Не вдалося зберегти зміст.");
}
