import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { DriveError } from "@/server/drive/google";
import { MAX_UPLOAD_BYTES, uploadBookFromBrowser } from "@/server/drive/upload";
import { ingestUploadedMaterial } from "@/server/ingest/pipeline";
import { kickJobs } from "@/server/jobs/kick";

/**
 * "Завантажити файл" (ADR-024 §6, US-2.7 КП-5): streams the request body
 * straight into a Drive resumable upload — never buffering the whole file
 * in this function's memory (BUG-003's fix, reversed) — then inserts the
 * `materials` row and kicks the ingest queue immediately, since the Drive
 * `files.create` response already carries everything the pipeline needs.
 *
 * Must run on the Node runtime (not Edge): streaming a `ReadableStream` as a
 * `fetch` request body needs `duplex: "half"`, which only Node's `undici`
 * honours the way this route depends on.
 */
export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** Server-only error codes → the specific parent-facing text lives in `uk.parent.books.upload` (BUG-005 pattern). */
export type UploadErrorCode = "too_large" | "unsupported_type" | "not_configured" | "failed";

function errorCodeOf(e: unknown): UploadErrorCode {
  if (e instanceof DriveError) {
    if (e.code === "too_large") return "too_large";
    if (e.code === "not_configured") return "not_configured";
    if (e.code === "unsupported_type") return "unsupported_type";
  }
  return "failed";
}

export async function POST(request: NextRequest) {
  const { familyId } = await requireParentAccess();
  if (!request.body) return NextResponse.json({ error: "failed" satisfies UploadErrorCode }, { status: 400 });

  const fileNameHeader = request.headers.get("x-file-name");
  const fileName = fileNameHeader ? decodeURIComponent(fileNameHeader) : "book";
  const mimeType = request.headers.get("content-type") || "application/octet-stream";
  const declaredSizeHeader = request.headers.get("content-length");
  const declaredSize = declaredSizeHeader ? Number(declaredSizeHeader) : null;

  // Cheap early rejection before touching Drive at all, on top of the
  // streamed byte count enforced below (a lying/missing header must not
  // let an oversized file slip through, same reasoning as BUG-003).
  if (declaredSize != null && Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "too_large" satisfies UploadErrorCode }, { status: 413 });
  }

  try {
    const file = await uploadBookFromBrowser({
      familyId,
      body: request.body,
      fileName,
      mimeType,
      declaredSize: Number.isFinite(declaredSize) ? declaredSize : null,
    });
    const { status } = await ingestUploadedMaterial(familyId, file);
    if (status === "queued") kickJobs();
    return NextResponse.json({ ok: true, status });
  } catch (e) {
    const code = errorCodeOf(e);
    if (code === "failed") console.error(`book upload failed: ${(e as Error).name}: ${(e as Error).message}`);
    const status =
      code === "too_large" ? 413 : code === "unsupported_type" ? 415 : code === "not_configured" ? 503 : 500;
    return NextResponse.json({ error: code }, { status });
  }
}
