import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { DriveError } from "@/server/drive/google";
import { confirmUpload } from "@/server/drive/upload";
import { ingestUploadedMaterial } from "@/server/ingest/pipeline";
import { kickJobs } from "@/server/jobs/kick";

/**
 * "Завантажити файл", step 2 of 2 (ADR-024 §6, BUG-033): a lightweight
 * request (just the `driveFileId` the browser got back after `PUT`ing the
 * file straight to Google's resumable session URI) that re-fetches the
 * file's real metadata from Drive itself, then continues exactly as the old
 * single-request upload used to — `ingestUploadedMaterial` + `kickJobs()`.
 */
export const dynamic = "force-dynamic";

export type UploadErrorCode = "too_large" | "unsupported_type" | "not_configured" | "failed";

function errorCodeOf(e: unknown): UploadErrorCode {
  if (e instanceof DriveError) {
    if (e.code === "too_large") return "too_large";
    if (e.code === "not_configured") return "not_configured";
    if (e.code === "unsupported_type") return "unsupported_type";
  }
  return "failed";
}

interface CompleteUploadBody {
  driveFileId?: unknown;
}

export async function POST(request: NextRequest) {
  const { familyId } = await requireParentAccess();
  const body = (await request.json().catch(() => null)) as CompleteUploadBody | null;
  const driveFileId = typeof body?.driveFileId === "string" ? body.driveFileId : null;
  if (!driveFileId) return NextResponse.json({ error: "failed" satisfies UploadErrorCode }, { status: 400 });

  try {
    const file = await confirmUpload({ familyId, driveFileId });
    const { status } = await ingestUploadedMaterial(familyId, file);
    if (status === "queued") kickJobs();
    return NextResponse.json({ ok: true, status });
  } catch (e) {
    const code = errorCodeOf(e);
    if (code === "failed") console.error(`book upload confirm failed: ${(e as Error).name}: ${(e as Error).message}`);
    const status =
      code === "too_large" ? 413 : code === "unsupported_type" ? 415 : code === "not_configured" ? 503 : 500;
    return NextResponse.json({ error: code }, { status });
  }
}
