import "server-only";
import { createSign } from "node:crypto";
import type { GoogleServiceAccount } from "../env";

/**
 * Minimal Google Drive v3 client for the materials folder (ADR-003):
 * a service account with the "Viewer" role reads the folder; no SDK needed.
 * IDs and links are never logged (NFR-PRIV-8).
 */
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: "not_configured" | "not_found" | "forbidden" | "too_large" | "http" | "network",
  ) {
    super(message);
    this.name = "DriveError";
  }
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** RS256-signed JWT assertion for the OAuth 2.0 JWT bearer flow. */
export function buildServiceAccountAssertion(sa: GoogleServiceAccount, nowSec: number, scope = SCOPE): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.clientEmail, scope, aud: sa.tokenUri, iat: nowSec, exp: nowSec + 3600 }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

let tokenCache: { email: string; token: string; expiresAt: number } | null = null;

export async function getAccessToken(sa: GoogleServiceAccount, fetchImpl: typeof fetch = fetch): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.email === sa.clientEmail && tokenCache.expiresAt - 60_000 > now) return tokenCache.token;
  let res: Response;
  try {
    res = await fetchImpl(sa.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: buildServiceAccountAssertion(sa, Math.floor(now / 1000)),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DriveError("token request failed", null, "network");
  }
  if (!res.ok) throw new DriveError(`token request rejected (${res.status})`, res.status, "forbidden");
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new DriveError("no access token", res.status, "forbidden");
  tokenCache = { email: sa.clientEmail, token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

/** Drive IDs are URL-safe base64-ish strings; anything else is rejected (no query injection). */
export function isValidDriveId(id: string | null | undefined): id is string {
  return !!id && /^[A-Za-z0-9_-]{10,200}$/.test(id);
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SUPPORTED_MIME: Record<string, "pdf" | "epub"> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
};

/** Format by MIME type or by extension (Drive sometimes reports octet-stream for EPUB). */
export function formatOf(file: Pick<DriveFile, "name" | "mimeType">): "pdf" | "epub" | null {
  const byMime = SUPPORTED_MIME[file.mimeType];
  if (byMime) return byMime;
  const ext = file.name.toLowerCase().split(".").pop();
  return ext === "pdf" ? "pdf" : ext === "epub" ? "epub" : null;
}

async function driveGet(url: string, token: string, fetchImpl: typeof fetch, timeoutMs = 30_000): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new DriveError("drive request failed", null, "network");
  }
  if (res.status === 404) throw new DriveError("drive item not found or not shared", 404, "not_found");
  if (res.status === 401 || res.status === 403) throw new DriveError(`drive access denied (${res.status})`, res.status, "forbidden");
  if (!res.ok) throw new DriveError(`drive error ${res.status}`, res.status, "http");
  return res;
}

/**
 * Lists supported files in the folder and its subfolders (subfolders are only
 * hints, ADR-017; depth-limited). Other files are counted, not returned.
 */
export async function listFolderFiles(
  folderId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  maxDepth = 3,
): Promise<{ files: (DriveFile & { format: "pdf" | "epub" })[]; skipped: number }> {
  if (!isValidDriveId(folderId)) throw new DriveError("invalid folder id", null, "not_configured");
  const files: (DriveFile & { format: "pdf" | "epub" })[] = [];
  let skipped = 0;
  const queue: { id: string; depth: number }[] = [{ id: folderId, depth: 0 }];
  const seen = new Set<string>();
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${id}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime, size)",
        pageSize: "200",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await driveGet(`${DRIVE_API}/files?${params}`, token, fetchImpl);
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      for (const f of body.files ?? []) {
        if (f.mimeType === FOLDER_MIME) {
          if (depth < maxDepth && isValidDriveId(f.id)) queue.push({ id: f.id, depth: depth + 1 });
          continue;
        }
        const format = formatOf(f);
        if (format) files.push({ ...f, format });
        else skipped += 1;
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
  }
  return { files, skipped };
}

export const MAX_FILE_BYTES = 150 * 1024 * 1024;

export async function downloadFile(fileId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  if (!isValidDriveId(fileId)) throw new DriveError("invalid file id", null, "not_found");
  const res = await driveGet(`${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`, token, fetchImpl, 120_000);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_FILE_BYTES) throw new DriveError("file too large", 413, "too_large");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_FILE_BYTES) throw new DriveError("file too large", 413, "too_large");
  return buf;
}
