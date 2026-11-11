import "server-only";
import { createServiceClient } from "@/server/supabase/clients";
const BUCKET = "audiobooks";
let configured = false;
export async function ensureAudioBucket() {
  if (configured) return;
  const db = createServiceClient(); const { data, error } = await db.storage.getBucket(BUCKET);
  if (data?.public) throw new Error("Сховище аудіокниг має бути приватним.");
  if (error || !data) { const created = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 20 * 1024 * 1024, allowedMimeTypes: ["audio/mpeg"] }); if (created.error && !/already exists|duplicate/i.test(created.error.message)) throw new Error("Не вдалося підготувати приватне сховище аудіо."); const verified = await db.storage.getBucket(BUCKET); if (verified.error || !verified.data || verified.data.public) throw new Error("Не підтверджено приватне сховище аудіо."); }
  configured = true;
}
function audioPath(familyId: string, id: string, key: string) {
  if (![familyId, id].every(v => /^[a-f0-9-]{36}$/i.test(v)) || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Некоректне посилання аудіо.");
  return `${familyId}/${id}/${key}.mp3`;
}
export async function audioExists(familyId: string, id: string, key: string) {
  await ensureAudioBucket(); const { data, error } = await createServiceClient().storage.from(BUCKET).exists(audioPath(familyId, id, key));
  if (error) throw new Error("Не вдалося перевірити збережений аудіофрагмент."); return !!data;
}
export async function saveAudioBytes(familyId: string, id: string, key: string, base64: string) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 100 || bytes.length > 20 * 1024 * 1024) throw new Error("Не отримано коректний аудіофрагмент.");
  const { error } = await createServiceClient().storage.from(BUCKET).upload(audioPath(familyId, id, key), bytes, { contentType: "audio/mpeg", upsert: true, cacheControl: "3600" });
  if (error) throw new Error("Не вдалося зберегти оплачений аудіофрагмент. Вартість враховано, автоматичного повтору немає.");
}
export async function signedAudioUrl(familyId: string, id: string, key: string) {
  const { data, error } = await createServiceClient().storage.from(BUCKET).createSignedUrl(audioPath(familyId, id, key), 90);
  if (error || !data) throw new Error("Не вдалося відкрити аудіофрагмент."); return data.signedUrl;
}
export async function deleteAudioBytes(familyId: string, id: string, keys: string[]) {
  if (!keys.length) return;
  const { error } = await createServiceClient().storage.from(BUCKET).remove([...new Set(keys)].map(key => audioPath(familyId, id, key)));
  if (error) throw new Error("Не вдалося видалити аудіофайли. Повтори видалення.");
}
