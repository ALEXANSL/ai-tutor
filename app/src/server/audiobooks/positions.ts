import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { documentId } from "./store";
export type AudioPosition = { segment: number; seconds: number; speed: number; bookmark: { segment: number; seconds: number } | null };
export async function readAudioPosition(familyId: string, userId: string, partId: string): Promise<AudioPosition | null> {
  const { data, error } = await forFamily(familyId).select("jobs", "payload").eq("id", documentId(`${familyId}:audio-position:${userId}:${partId}`)).eq("type", "audiobook.position").maybeSingle<{ payload: AudioPosition }>();
  if (error) throw new Error("Не вдалося прочитати місце зупинки."); return data?.payload ?? null;
}
export async function saveAudioPosition(familyId: string, userId: string, partId: string, payload: AudioPosition) {
  const { error } = await forFamily(familyId).upsert("jobs", { id: documentId(`${familyId}:audio-position:${userId}:${partId}`), type: "audiobook.position", status: "done", payload: { ...payload, partId, userId } }, "id");
  if (error) throw new Error("Не вдалося зберегти місце зупинки.");
}
