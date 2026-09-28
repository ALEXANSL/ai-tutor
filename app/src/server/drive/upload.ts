import "server-only";
import { MAX_UPLOAD_BYTES } from "../../lib/upload-limits";
import { getFamilyIntegration } from "../integrations";
import { DriveError, formatOf, isValidDriveId } from "./google";
import { getUserAccessToken } from "./oauth";

/**
 * Direct book upload from the parent's browser (ADR-024 §6, BUG-033).
 *
 * BUG-033: Vercel Serverless Functions reject any request body over ~4.5 MB
 * at the platform/routing layer, before our function code ever runs — no
 * amount of streaming inside the function (the previous `boundedUploadStream`
 * approach) can work around that, because the request never reaches us. The
 * fix is the standard pattern for large uploads on serverless platforms: the
 * file bytes never pass through our server at all.
 *
 *   1. `initResumableUpload` — a *lightweight* call (JSON metadata only, no
 *      file bytes) that asks Google Drive for a resumable upload session
 *      (`files.create` with `uploadType=resumable`) and returns the
 *      short-lived, file-specific `session URI` Google hands back in the
 *      `Location` header. This URI is safe to send to the browser: unlike
 *      the OAuth access/refresh token (which never leaves this server), it
 *      only allows uploading bytes for the one file this session was opened
 *      for, and expires on its own.
 *   2. The browser `PUT`s the file straight to that session URI — directly
 *      to `googleapis.com`, never touching our Vercel function — which is
 *      what actually bypasses the platform body-size limit.
 *   3. `confirmUpload` — another lightweight call (just the resulting
 *      `drive_file_id`) that re-fetches the file's metadata from Drive
 *      itself (never trusting client-supplied name/mime/size) to guard
 *      against a confused-deputy request, then hands it to
 *      `ingestUploadedMaterial`.
 *
 * Practical limit ≈ 50 MB (`lib/upload-limits.ts`) remains a *product*
 * decision, not a platform one — Google's resumable sessions themselves
 * support much larger files — so it is enforced both up front (declared
 * size, for instant client feedback) and again in `confirmUpload` (the real
 * size Drive reports once the upload is done).
 */
export { MAX_UPLOAD_BYTES };
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

const CANONICAL_MIME: Record<"pdf" | "epub", string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
};

export interface UploadedDriveFile {
  id: string;
  name: string;
  mimeType: string;
  format: "pdf" | "epub";
  size: number | null;
  modifiedTime: string | null;
  md5Checksum: string | null;
}

/** A safe Drive file name: no path separators, trimmed length. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").trim();
  return (cleaned || "book").slice(0, 200);
}

export interface InitResumableUploadOptions {
  familyId: string;
  fileName: string;
  mimeType: string;
  /** Reported by the browser from `File.size` — an early, cheap check before opening a Drive session at all. */
  declaredSize: number | null;
  fetchImpl?: typeof fetch;
}

export interface ResumableUploadSession {
  /** The Google-hosted, file-specific, short-lived URI the browser PUTs the file bytes to directly. */
  sessionUrl: string;
}

/**
 * Opens a Google Drive resumable upload session for the app-owned "Мої
 * книги" folder (ADR-024 §6, BUG-033) — a metadata-only POST, no file bytes
 * involved, so it never risks Vercel's request-body limit. Throws
 * `DriveError` with a specific `code` the caller maps to a concrete
 * parent-facing message (BUG-005 pattern): `too_large`, `unsupported_type`,
 * `not_configured` (OAuth/folder not set up), or a generic `http`/`network`
 * failure.
 */
export async function initResumableUpload(opts: InitResumableUploadOptions): Promise<ResumableUploadSession> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const format = formatOf({ name: opts.fileName, mimeType: opts.mimeType });
  // ADR-031 §3.8: a manual-import batch ZIP is placed straight in the Drive
  // folder and picked up by `syncDriveFolder` — this direct-upload widget
  // (PDF/EPUB only, browser size limit) never handles it.
  if (!format || format === "zip") throw new DriveError("unsupported file type", null, "unsupported_type");
  if (opts.declaredSize != null && opts.declaredSize > MAX_UPLOAD_BYTES) {
    throw new DriveError("file too large", 413, "too_large");
  }

  const folderId = await getFamilyIntegration(opts.familyId, "drive_uploads_folder");
  if (!isValidDriveId(folderId)) throw new DriveError("uploads folder is not configured", null, "not_configured");
  const token = await getUserAccessToken(opts.familyId, fetchImpl);

  const name = sanitizeFileName(opts.fileName);
  const mimeType = CANONICAL_MIME[format];
  const initParams = new URLSearchParams({
    uploadType: "resumable",
    supportsAllDrives: "true",
    fields: "id,name,mimeType,size,modifiedTime,md5Checksum,parents",
  });
  let initRes: Response;
  try {
    initRes = await fetchImpl(`${DRIVE_UPLOAD_API}/files?${initParams}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mimeType,
        ...(opts.declaredSize != null ? { "x-upload-content-length": String(opts.declaredSize) } : {}),
      },
      body: JSON.stringify({ name, mimeType, parents: [folderId] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DriveError("drive upload session request failed", null, "network");
  }
  if (!initRes.ok) throw new DriveError(`drive upload session failed (${initRes.status})`, initRes.status, "http");
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) throw new DriveError("drive upload session missing location", null, "http");
  return { sessionUrl };
}

export interface ConfirmUploadOptions {
  familyId: string;
  /** The `id` the browser got back from Drive once its direct `PUT` to the session URI finished. Never trusted on its own — re-fetched below. */
  driveFileId: string;
  fetchImpl?: typeof fetch;
}

/**
 * Re-fetches the just-uploaded file's metadata straight from Drive (never
 * trusting client-supplied name/mime/size, since the confirm request body
 * is otherwise just a bare id) and confirms it actually landed in *this*
 * family's uploads folder — the confused-deputy guard ADR-024 §9 calls for,
 * now done at confirm time since the server no longer sees the bytes (or
 * the `files.create` response) itself.
 */
export async function confirmUpload(opts: ConfirmUploadOptions): Promise<UploadedDriveFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!isValidDriveId(opts.driveFileId)) throw new DriveError("invalid file id", null, "not_found");

  const folderId = await getFamilyIntegration(opts.familyId, "drive_uploads_folder");
  if (!isValidDriveId(folderId)) throw new DriveError("uploads folder is not configured", null, "not_configured");
  const token = await getUserAccessToken(opts.familyId, fetchImpl);

  const params = new URLSearchParams({
    supportsAllDrives: "true",
    fields: "id,name,mimeType,size,modifiedTime,md5Checksum,parents",
  });
  let res: Response;
  try {
    res = await fetchImpl(`${DRIVE_API}/files/${opts.driveFileId}?${params}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DriveError("drive file lookup failed", null, "network");
  }
  if (res.status === 404) throw new DriveError("drive item not found or not shared", 404, "not_found");
  if (res.status === 401 || res.status === 403) throw new DriveError(`drive access denied (${res.status})`, res.status, "forbidden");
  if (!res.ok) throw new DriveError(`drive error ${res.status}`, res.status, "http");

  const file = (await res.json()) as {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    md5Checksum?: string;
    parents?: string[];
  };

  if (!file.parents?.includes(folderId)) {
    throw new DriveError("uploaded file is not in the uploads folder", 403, "forbidden");
  }
  const format = formatOf({ name: file.name, mimeType: file.mimeType });
  if (!format || format === "zip") throw new DriveError("unsupported file type", null, "unsupported_type");
  const size = file.size ? Number(file.size) : null;
  if (size != null && size > MAX_UPLOAD_BYTES) throw new DriveError("file too large", 413, "too_large");

  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    format,
    size,
    modifiedTime: file.modifiedTime ?? null,
    md5Checksum: file.md5Checksum ?? null,
  };
}
