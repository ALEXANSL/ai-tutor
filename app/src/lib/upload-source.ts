import { SOURCE_MIME, sourceFileFormat } from "./source-files";

/** Only file-specific Google resumable URLs may receive the selected private file. */
export function isDriveUploadUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && ["www.googleapis.com", "content.googleapis.com", "googleapis.com"].includes(url.hostname) && url.pathname.startsWith("/upload/drive/"); }
  catch { return false; }
}
export class SourceUploadError extends Error {
  constructor(readonly code: string) { super(code); }
}
export async function openSourceUpload(file: File): Promise<string> {
  const response = await fetch("/api/parent/books/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream", size: file.size }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !isDriveUploadUrl(data.sessionUrl)) throw new SourceUploadError(data.error || "failed");
  return data.sessionUrl;
}
/** Retry first asks the same resumable session whether Google already completed it. */
export async function putSourceUpload(file: File, sessionUrl: string, progress: (value: number) => void, retry = false): Promise<string> {
  if (!isDriveUploadUrl(sessionUrl)) throw new SourceUploadError("failed");
  if (retry) {
    const status = await fetch(sessionUrl, { method: "PUT", headers: { "content-range": `bytes */${file.size}` }, body: new Blob([]) });
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
export async function completeSourceUpload(driveFileId: string): Promise<string> {
  const response = await fetch("/api/parent/books/upload/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ driveFileId }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.materialId !== "string") throw new SourceUploadError(result.error || "failed");
  return result.materialId;
}
