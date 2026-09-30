import "server-only";
import { getFamilyIntegration } from "../integrations";
import { DriveError, isValidDriveId } from "./google";
import { getUserAccessToken } from "./oauth";

/**
 * S33 (PO decision 2026-09-30, third and final correction): the COMPLETE
 * text of a literary work covered by a literature-extraction topic is never
 * stored in our own Supabase DB (copyright — only short quoted excerpts
 * live there, `literature_lessons.work_excerpts_uk`). Instead it is written
 * as a small (KB-scale) plain-text file into the family's OWN Google Drive
 * — the same already-connected `drive.file` OAuth grant used for book
 * uploads (ADR-024, `drive/upload.ts`) — and only its `drive_file_id` is
 * kept in our DB (`literature_lessons.work_full_text_drive_file_id`). The
 * text written here is already-recognized text the extraction pipeline
 * itself sliced from the already-indexed `chunks` (never a fresh OCR/PDF
 * scan, never AI-regenerated) — see `literatureExtraction.ts`.
 *
 * Reading it back uses a short in-memory TTL cache (`READ_CACHE_TTL_MS`) —
 * not a DB write, not `localStorage` — per the PO's explicit instruction:
 * fetched on demand right before the child wants to read the full text,
 * kept only for a few minutes to avoid repeat Drive round-trips within one
 * lesson-viewing session, then simply falls out of the cache. The cache is
 * per-server-instance and best-effort; a cold miss just re-fetches from
 * Drive (small file, fast) — never a correctness issue, only a minor
 * latency one.
 */

const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Plain multipart upload (metadata + small text body in one request) — no resumable session needed at this size (KB-scale, not the 50 MB book-upload path in `drive/upload.ts`). */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").trim();
  return (cleaned || "work").slice(0, 150);
}

export async function saveWorkFullTextToDrive(familyId: string, fileName: string, text: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const folderId = await getFamilyIntegration(familyId, "drive_uploads_folder");
  if (!isValidDriveId(folderId)) throw new DriveError("uploads folder is not configured", null, "not_configured");
  const token = await getUserAccessToken(familyId, fetchImpl);

  const boundary = `lit-work-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: sanitizeFileName(fileName), mimeType: "text/plain", parents: [folderId] });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n` +
    `--${boundary}--`;

  let res: Response;
  try {
    res = await fetchImpl(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id&supportsAllDrives=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DriveError("drive work-text upload request failed", null, "network");
  }
  if (!res.ok) throw new DriveError(`drive work-text upload failed (${res.status})`, res.status, "http");
  const data = (await res.json().catch(() => null)) as { id?: string } | null;
  if (!data?.id) throw new DriveError("drive work-text upload: missing id in response", null, "http");
  return data.id;
}

const READ_CACHE_TTL_MS = 5 * 60_000;
const readCache = new Map<string, { text: string; expiresAt: number }>();

export async function readWorkFullTextFromDrive(familyId: string, driveFileId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!isValidDriveId(driveFileId)) throw new DriveError("invalid file id", null, "not_found");
  const cached = readCache.get(driveFileId);
  if (cached && cached.expiresAt > Date.now()) return cached.text;

  const token = await getUserAccessToken(familyId, fetchImpl);
  let res: Response;
  try {
    res = await fetchImpl(`${DRIVE_API}/files/${driveFileId}?alt=media&supportsAllDrives=true`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DriveError("drive work-text download request failed", null, "network");
  }
  if (!res.ok) throw new DriveError(`drive work-text download failed (${res.status})`, res.status, res.status === 404 ? "not_found" : "http");
  const text = await res.text();
  readCache.set(driveFileId, { text, expiresAt: Date.now() + READ_CACHE_TTL_MS });
  return text;
}

/** Test-only: clears the module-level read cache between test runs. */
export function clearWorkTextReadCacheForTests(): void {
  readCache.clear();
}
