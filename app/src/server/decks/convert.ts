import "server-only";
import { randomUUID } from "node:crypto";
import { isValidDriveId } from "@/server/drive/google";
import { SOURCE_MIME } from "@/lib/source-files";

/** Drive's Office import/export uses the existing drive.file grant. The temporary
 * native copy lives in My Drive; only the uploaded original is kept. */
export async function renderDeckPdf(bytes: Uint8Array, token: string): Promise<Uint8Array> {
  const boundary = randomUUID();
  const headers = { authorization: `Bearer ${token}` };
  const meta = JSON.stringify({ name: "Тимчасовий перегляд слайдів", mimeType: "application/vnd.google-apps.presentation" });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${SOURCE_MIME.pptx}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const converted = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { ...headers, "content-type": `multipart/related; boundary=${boundary}` }, body, signal: AbortSignal.timeout(75000) });
  if (!converted.ok) throw new Error(`Google Drive не зміг відкрити PPTX (${converted.status}). Перевір файл і доступ до Drive.`);
  const { id } = await converted.json();
  if (!isValidDriveId(id)) throw new Error("Drive не повернув перетворену презентацію.");
  const url = `https://www.googleapis.com/drive/v3/files/${id}`;
  try {
    const result = await fetch(url + "/export?mimeType=application%2Fpdf", { headers, signal: AbortSignal.timeout(75000) });
    if (!result.ok) {
      const details = await result.json().catch(() => null);
      if (JSON.stringify(details).includes("exportSizeLimitExceeded")) throw new Error("Візуальна копія перевищила ліміт експорту Google Drive (10 МБ).");
      throw new Error(`Drive не зміг підготувати зображення слайдів (${result.status}).`);
    }
    return new Uint8Array(await result.arrayBuffer());
  } finally {
    const removed = await fetch(url, { method: "DELETE", headers, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!removed?.ok) console.warn("presentation temporary copy cleanup failed", removed?.status);
  }
}
