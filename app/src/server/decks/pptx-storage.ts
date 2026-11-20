import "server-only";
import { createServiceClient } from "@/server/supabase/clients";

export const PPTX_BUCKET = "lesson-presentations";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function storageFailure(operation: string, err: { message: string; statusCode?: unknown; status?: unknown }) {
  const status = Number(err.statusCode ?? err.status);
  if (/mime type|not supported|invalid mime/i.test(err.message)) return new Error(operation + ": сховище відхилило формат файлу.");
  if (status === 408) return new Error(operation + " — timeout (408)");
  if (status === 413 || /maximum allowed size|too large|size limit/i.test(err.message)) return new Error(operation + ": файл перевищує ліміт сховища.");
  if (status === 401 || status === 403) return new Error(operation + ": сервіс не має доступу до приватного сховища.");
  if (status >= 400 && status < 500 && ![408,429].includes(status)) return new Error(operation + " (HTTP " + status + ").");
  return new Error(operation + (status ? " (" + status + ")" : " — тимчасовий збій мережі (503)"));
}

export async function powerpointDestination() {
  const storage = createServiceClient().storage;
  let bucket = await storage.getBucket(PPTX_BUCKET);
  if (bucket.error && (/not found|does not exist/i.test(bucket.error.message) || Number(bucket.error.status) === 404)) {
    const result = await storage.createBucket(PPTX_BUCKET, {
      public: false, allowedMimeTypes: [PPTX_MIME], fileSizeLimit: 50 * 1024 * 1024,
    });
    if (result.error && !/already exists|duplicate/i.test(result.error.message)) throw storageFailure("Створення сховища PowerPoint", result.error);
    bucket = await storage.getBucket(PPTX_BUCKET);
  }
  if (bucket.error) throw storageFailure("Перевірка сховища PowerPoint", bucket.error);
  if (!bucket.data || bucket.data.public) throw new Error("Не підтверджено приватність сховища PowerPoint.");
  return storage.from(PPTX_BUCKET);
}
