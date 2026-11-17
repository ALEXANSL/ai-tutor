/** Small enough for Vercel bodies; a multiple of Google's 256 KiB resumable unit. */
export const SOURCE_CHUNK_BYTES = 1024 * 1024;
export const SOURCE_CHUNK_PATH = "/api/parent/books/upload/chunk";
export function isDriveUploadUrl(value: string) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && ["www.googleapis.com", "content.googleapis.com", "googleapis.com"].includes(url.hostname) && url.pathname.startsWith("/upload/drive/"); }
  catch { return false; }
}
export function isSourceProxyUrl(value: string) {
  if (!value.startsWith(`${SOURCE_CHUNK_PATH}?`)) return false;
  try { const url = new URL(value, "https://local.invalid"); return url.pathname === SOURCE_CHUNK_PATH && !url.hash && url.searchParams.size === 1 && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(url.searchParams.get("uploadId") ?? ""); }
  catch { return false; }
}
