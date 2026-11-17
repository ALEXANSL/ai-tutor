import "server-only";
import { randomUUID } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { isDriveUploadUrl, SOURCE_CHUNK_BYTES, SOURCE_CHUNK_PATH } from "@/lib/source-upload-contract";
import { getUserAccessToken } from "./oauth";
import { DriveError } from "./google";
const TYPE = "source.upload_session";
interface Session { sessionUrl: string; size: number; mimeType: string; createdAt: string; driveFileId?: string; }
export class UploadRelayError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
export async function createUploadRelay(familyId: string, sessionUrl: string, size: number, mimeType: string) {
  if (!isDriveUploadUrl(sessionUrl) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) throw new UploadRelayError("failed");
  const id = randomUUID(); const payload: Session = { sessionUrl, size, mimeType, createdAt: new Date().toISOString() };
  const saved = await forFamily(familyId).insert("jobs", { id, type: TYPE, status: "done", payload });
  if (saved.error) throw new UploadRelayError("failed", 503);
  return `${SOURCE_CHUNK_PATH}?uploadId=${id}`;
}
async function readSession(familyId: string, id: string): Promise<Session> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new UploadRelayError("failed");
  const row = await forFamily(familyId).select("jobs", "payload").eq("id", id).eq("type", TYPE).maybeSingle<{ payload: Session }>();
  if (row.error) throw new UploadRelayError("failed", 503);
  const session = row.data?.payload;
  if (!session || !isDriveUploadUrl(session.sessionUrl) || !Number.isSafeInteger(session.size) || session.size <= 0 || session.size > MAX_UPLOAD_BYTES) throw new UploadRelayError("session_expired", 404);
  if (!Number.isFinite(Date.parse(session.createdAt)) || Date.now() - Date.parse(session.createdAt) > 86400000) throw new UploadRelayError("session_expired", 410);
  return session;
}
export async function readUploadChunk(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > SOURCE_CHUNK_BYTES) throw new UploadRelayError("chunk_too_large", 413);
  const reader = request.body?.getReader(); if (!reader) throw new UploadRelayError("failed");
  const parts: Uint8Array[] = []; let size = 0;
  try { while (true) { const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > SOURCE_CHUNK_BYTES) throw new UploadRelayError("chunk_too_large", 413); parts.push(value.value); } } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}
export interface RelayResult { offset: number; driveFileId?: string; }
export async function relaySourceUpload(familyId: string, id: string, chunk?: { bytes: Uint8Array; range: string }): Promise<RelayResult> {
  const session = await readSession(familyId, id);
  if (session.driveFileId) return { offset: session.size, driveFileId: session.driveFileId };
  let contentRange = `bytes */${session.size}`;
  if (chunk) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(chunk.range);
    const start = Number(match?.[1]), end = Number(match?.[2]), total = Number(match?.[3]);
    if (!match || ![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= session.size || total !== session.size || end - start + 1 !== chunk.bytes.length || !chunk.bytes.length || chunk.bytes.length > SOURCE_CHUNK_BYTES) throw new UploadRelayError("invalid_range");
    contentRange = chunk.range;
  }
  let token: string;
  try { token = await getUserAccessToken(familyId); }
  catch (error) { throw new UploadRelayError(error instanceof DriveError && error.code === "not_configured" ? "not_configured" : error instanceof DriveError && error.code === "network" ? "network" : "drive_access", 503); }
  let response: Response;
  try { response = await fetch(session.sessionUrl, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": session.mimeType, "content-range": contentRange }, body: chunk ? new Blob([Buffer.from(chunk.bytes)]) : new Blob([]), redirect: "manual", signal: AbortSignal.timeout(60000) }); }
  catch { throw new UploadRelayError("network", 502); }
  if (response.status === 308) {
    const range = response.headers.get("range"), parsed = range ? /^bytes=0-(\d+)$/.exec(range) : null;
    const offset = parsed ? Number(parsed[1]) + 1 : range ? NaN : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.size) throw new UploadRelayError("failed", 502);
    return { offset };
  }
  if ([404, 410].includes(response.status)) throw new UploadRelayError("session_expired", 410);
  if ([401, 403].includes(response.status)) throw new UploadRelayError("drive_access", 403);
  if (!response.ok) throw new UploadRelayError("network", 502);
  const file = await response.json().catch(() => null);
  if (typeof file?.id !== "string" || !/^[a-zA-Z0-9_-]{10,200}$/.test(file.id)) throw new UploadRelayError("failed", 502);
  const saved = await forFamily(familyId).update("jobs", { payload: { ...session, driveFileId: file.id } }).eq("id", id).eq("type", TYPE);
  if (saved.error) throw new UploadRelayError("failed", 503);
  return { offset: session.size, driveFileId: file.id };
}
