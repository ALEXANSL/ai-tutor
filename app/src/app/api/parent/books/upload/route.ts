import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { DriveError } from "@/server/drive/google";
import { initResumableUpload, MAX_UPLOAD_BYTES } from "@/server/drive/upload";

/**
 * "Завантажити файл" (ADR-024 §6, BUG-033): opens a Google Drive resumable
 * upload session and hands the browser its short-lived session URI — a
 * metadata-only request/response, never any file bytes, so it can never hit
 * Vercel's ~4.5 MB request-body limit (BUG-033's root cause). The browser
 * then `PUT`s the file straight to that URI itself (see
 * `UploadBookButton.tsx`); this route never sees the file at all.
 */
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

interface InitUploadBody {
  fileName?: unknown;
  mimeType?: unknown;
  size?: unknown;
}

export async function POST(request: NextRequest) {
  const { familyId } = await requireParentAccess();
  const body = (await request.json().catch(() => null)) as InitUploadBody | null;
  const fileName = typeof body?.fileName === "string" ? body.fileName : "book";
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "application/octet-stream";
  const declaredSize = typeof body?.size === "number" && Number.isFinite(body.size) ? body.size : null;

  // Cheap early rejection before touching Drive at all — a lying/missing
  // size must not let an oversized file slip past client-side feedback (the
  // real, server-enforced check happens again in `confirmUpload` once Drive
  // reports the actual uploaded size).
  if (declaredSize != null && declaredSize > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "too_large" satisfies UploadErrorCode }, { status: 413 });
  }

  try {
    const session = await initResumableUpload({ familyId, fileName, mimeType, declaredSize });
    return NextResponse.json({ ok: true, sessionUrl: session.sessionUrl });
  } catch (e) {
    const code = errorCodeOf(e);
    if (code === "failed") console.error(`book upload session failed: ${(e as Error).name}: ${(e as Error).message}`);
    const status =
      code === "too_large" ? 413 : code === "unsupported_type" ? 415 : code === "not_configured" ? 503 : 500;
    return NextResponse.json({ error: code }, { status });
  }
}
