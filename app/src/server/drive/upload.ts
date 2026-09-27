import "server-only";
import { MAX_UPLOAD_BYTES } from "../../lib/upload-limits";
import { getFamilyIntegration } from "../integrations";
import { DriveError, formatOf, isValidDriveId } from "./google";
import { getUserAccessToken } from "./oauth";

/**
 * Direct book upload from the parent's browser (ADR-024 §6, US-2.7 КП-5).
 * Practical limit ≈ 50 MB (`lib/upload-limits.ts`) — deliberately below
 * `MAX_FILE_BYTES` (150 MB, `google.ts`), which only guards the Drive →
 * server download used by indexing (BUG-003). A bigger file still goes
 * through the existing "put it in the Drive folder by hand" path.
 */
export { MAX_UPLOAD_BYTES };
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

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

/**
 * Wraps the incoming request stream with a running byte counter and errors
 * the stream (instead of buffering the file) as soon as it crosses
 * `maxBytes` — the same technique BUG-003 introduced for the opposite
 * direction (`downloadFile`'s `readBounded`), applied here to the browser →
 * server → Drive upload.
 */
export function boundedUploadStream(
  input: ReadableStream<Uint8Array>,
  maxBytes: number,
): { stream: ReadableStream<Uint8Array>; tooLarge: () => boolean } {
  const reader = input.getReader();
  let total = 0;
  let tooLarge = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        await reader.cancel("file too large").catch(() => {});
        controller.error(new Error("file too large"));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, tooLarge: () => tooLarge };
}

/** A safe Drive file name: no path separators, trimmed length. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").trim();
  return (cleaned || "book").slice(0, 200);
}

export interface UploadBookOptions {
  familyId: string;
  body: ReadableStream<Uint8Array>;
  fileName: string;
  mimeType: string;
  /** From the `Content-Length` header, if the browser sent one — an early, cheap check before streaming starts. */
  declaredSize: number | null;
  fetchImpl?: typeof fetch;
}

/**
 * Streams the request body straight into a Drive resumable upload session
 * for the app-owned "Мої книги" folder — never buffering the whole file in
 * the function's memory (ADR-024 §6). Throws `DriveError` with a specific
 * `code` the caller maps to a concrete parent-facing message (BUG-005
 * pattern): `too_large`, `not_configured` (OAuth/folder not set up), or a
 * generic `http`/`network` failure.
 */
export async function uploadBookFromBrowser(opts: UploadBookOptions): Promise<UploadedDriveFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const format = formatOf({ name: opts.fileName, mimeType: opts.mimeType });
  if (!format) throw new DriveError("unsupported file type", null, "unsupported_type");
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
    fields: "id,name,mimeType,size,modifiedTime,md5Checksum",
  });
  let initRes: Response;
  try {
    initRes = await fetchImpl(`${DRIVE_UPLOAD_API}/files?${initParams}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mimeType,
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

  const { stream, tooLarge } = boundedUploadStream(opts.body, MAX_UPLOAD_BYTES);
  let putRes: Response;
  try {
    putRes = await fetchImpl(sessionUrl, {
      method: "PUT",
      // `duplex: "half"` is required by undici/Node fetch to send a streaming
      // body; the DOM `RequestInit` type does not know about it yet.
      ...({ duplex: "half" } as Record<string, unknown>),
      body: stream,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    if (tooLarge()) throw new DriveError("file too large", 413, "too_large");
    throw new DriveError(`drive upload failed: ${(e as Error).message}`, null, "network");
  }
  if (!putRes.ok) {
    if (tooLarge()) throw new DriveError("file too large", 413, "too_large");
    throw new DriveError(`drive upload rejected (${putRes.status})`, putRes.status, "http");
  }
  const file = (await putRes.json()) as {
    id: string;
    name: string;
    mimeType: string;
    size?: string;
    modifiedTime?: string;
    md5Checksum?: string;
  };
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    format,
    size: file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime ?? null,
    md5Checksum: file.md5Checksum ?? null,
  };
}
