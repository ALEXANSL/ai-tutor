import { SOURCE_MIME, SOURCE_FILE_LABEL, sourceFileFormat } from "./source-files";

import { isDriveUploadUrl, isSourceProxyUrl, SOURCE_CHUNK_BYTES } from "./source-upload-contract";
export { isDriveUploadUrl } from "./source-upload-contract";

export class SourceUploadError extends Error {
  constructor(readonly code: string) { super(code); }
}
export async function openSourceUpload(file: File): Promise<string> {
  const response = await sourceFetch("/api/parent/books/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream", size: file.size }) });
  const data = await response.json().catch(() => ({}));
  if (response.ok && isSourceProxyUrl(data.uploadUrl ?? "")) return data.uploadUrl;
  if (!response.ok || !isDriveUploadUrl(data.sessionUrl)) throw new SourceUploadError(data.error || "failed");
  return data.sessionUrl;
}
/** Retry first asks the same resumable session whether Google already completed it. */
export async function putSourceUpload(file: File, sessionUrl: string, progress: (value: number) => void, retry = false): Promise<string> {
  if (isSourceProxyUrl(sessionUrl)) return putProxyBytes(file, sessionUrl, progress, retry);
  if (!isDriveUploadUrl(sessionUrl)) throw new SourceUploadError("failed");
  if (retry) {
    const status = await sourceFetch(sessionUrl, { method: "PUT", headers: { "content-range": `bytes */${file.size}` }, body: new Blob([]) });
    if (status.ok) { const done = await status.json(); if (typeof done.id === "string") return done.id; }
    // Resend only an untouched session. A partial session needs a range upload, handled below.
    if (status.status !== 308) throw new SourceUploadError("failed");
    const offset = Number(status.headers.get("range")?.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1;
    return sendBytes(file, sessionUrl, progress, offset);
  }
  return sendBytes(file, sessionUrl, progress, 0);
}
function sendBytes(file: File, sessionUrl: string, progress: (value: number) => void, offset: number): Promise<string> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size) throw new SourceUploadError("failed");
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open("PUT", sessionUrl); request.timeout = 240000;
    const format = sourceFileFormat({ name: file.name, mimeType: file.type });
    request.setRequestHeader("Content-Type", format ? SOURCE_MIME[format] : "application/octet-stream");
    if (offset) request.setRequestHeader("Content-Range", `bytes ${offset}-${file.size - 1}/${file.size}`);
    request.upload.onprogress = event => { if (event.lengthComputable) progress(Math.min(100, Math.round((offset + event.loaded) / file.size * 100))); };
    request.onerror = request.ontimeout = () => reject(new SourceUploadError("network"));
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) { reject(new SourceUploadError(request.status === 413 ? "too_large" : "failed")); return; }
      try { const result = JSON.parse(request.responseText); if (typeof result.id !== "string") throw new Error(); resolve(result.id); }
      catch { reject(new SourceUploadError("failed")); }
    };
    request.send(offset ? file.slice(offset) : file);
  });
}
export async function completeSourceUpload(driveFileId: string, metadata?: { subjectId: string; category: string }): Promise<string> {
  const response = await sourceFetch("/api/parent/books/upload/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ driveFileId, ...metadata }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.materialId !== "string") throw new SourceUploadError(result.error || "failed");
  return result.materialId;
}

async function sourceFetch(url: string, init?: RequestInit) {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) }); }
  catch { throw new SourceUploadError("network"); }
  if (response.redirected || [401, 403].includes(response.status) && !(response.headers.get("content-type") ?? "").includes("application/json")) throw new SourceUploadError("auth_required");
  return response;
}
async function proxyResult(url: string, init?: RequestInit): Promise<{ offset: number; driveFileId?: string }> {
  const response = await sourceFetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new SourceUploadError(data?.error ?? ([401, 403].includes(response.status) ? "auth_required" : "network"));
  if (!data || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new SourceUploadError("failed");
  return data;
}
async function putProxyBytes(file: File, url: string, progress: (value: number) => void, retry: boolean) {
  let offset = 0;
  if (retry) { const saved = await proxyResult(url); if (saved.driveFileId) { progress(100); return saved.driveFileId; } offset = saved.offset; }
  if (offset > file.size) throw new SourceUploadError("invalid_range");
  while (offset < file.size) {
    const end = Math.min(file.size, offset + SOURCE_CHUNK_BYTES);
    const result = await proxyResult(url, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-range": `bytes ${offset}-${end - 1}/${file.size}` }, body: file.slice(offset, end) });
    if (result.offset > file.size) throw new SourceUploadError("invalid_range");
    if (result.driveFileId) { progress(100); return result.driveFileId; }
    if (result.offset <= offset) throw new SourceUploadError("network");
    offset = result.offset; progress(Math.min(100, Math.round(offset / file.size * 100)));
  }
  const done = await proxyResult(url); if (done.driveFileId) { progress(100); return done.driveFileId; }
  throw new SourceUploadError("network");
}
export function sourceUploadErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    network: "З’єднання перервалося під час завантаження. Вибраний файл залишається в цій вкладці. Натисни продовження — перевіримо, що вже збережено, і передамо решту.",
    auth_required: "Сесія входу або режим тата завершилися. Увійди знову перед продовженням завантаження.",
    session_expired: "Сесія завантаження прострочилася. Вибери цей файл повторно, щоб почати нове завантаження.",
    drive_access: "Google Drive відхилив доступ. Перевір підключення Google Drive в налаштуваннях.",
    not_configured: "Підключи Google Drive у налаштуваннях інтеграцій, щоб застосунок міг зберігати файли.",
    too_large: "Обери файл до 50 МБ.",
    unsupported_type: `Підтримуються ${SOURCE_FILE_LABEL}.`,
    invalid_range: "Не вдалося звірити передану частину. Натисни продовження — перевіримо стан збереженого файла.",
  };
  if (error instanceof SourceUploadError) return messages[error.code] ?? "Не вдалося завершити завантаження. Повтори: використаємо збережену сесію, а не нову копію файла.";
  return error instanceof Error && !/fetch|network|abort|load failed/i.test(error.message) ? error.message : messages.network!;
}
