import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";
import { createServiceClient } from "@/server/supabase/clients";

/**
 * "Завантажити матеріали" / категорія "Книга/уроки" (S34, PO decision
 * 2026-10-02) — step 1 of 2 for the course-package zip. Same reasoning as
 * `UploadBookButton.tsx`'s Drive resumable upload (BUG-033): Vercel
 * Serverless Functions reject any request body over ~4.5 MB at the
 * platform level, and the real package (1286 fragments + figures + pages)
 * is dozens of MB — far more than Alex's earlier attempt to send it through
 * a chat message could handle (he had to split it into 5+ archives just to
 * get it to the orchestrator for inspection). The fix here is the same
 * *shape* of fix as BUG-033 but a DIFFERENT mechanism: this zip is not a
 * book for the family's Drive, so instead of a Drive resumable session we
 * open a Supabase Storage **signed upload URL** in the private
 * `course_import_staging` bucket — a metadata-only request, no file bytes,
 * so it can never hit the platform limit either.
 *   1. this route (JSON only) asks Supabase Storage for a signed upload URL;
 *   2. the browser uploads the zip straight to Supabase Storage itself
 *      (`CourseZipUploadButton.tsx`), never touching our Vercel function;
 *   3. `/app/actions/course-import.ts`'s `importCoursePackageAction` (JSON
 *      only, just the resulting storage path) downloads and processes it
 *      server-side, then deletes the staged object.
 */
export const dynamic = "force-dynamic";

interface InitBody {
  fileName?: unknown;
  size?: unknown;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").trim();
  return (cleaned || "course.zip").slice(0, 200);
}

export async function POST(request: NextRequest) {
  const { familyId } = await requireParentAccess();
  const body = (await request.json().catch(() => null)) as InitBody | null;
  const fileName = typeof body?.fileName === "string" ? body.fileName : "course.zip";
  const declaredSize = typeof body?.size === "number" && Number.isFinite(body.size) ? body.size : null;

  if (!fileName.toLowerCase().endsWith(".zip")) {
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }
  if (declaredSize != null && declaredSize > MAX_COURSE_ZIP_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const storagePath = `${familyId}/${randomUUID()}-${sanitizeFileName(fileName)}`;
  const client = createServiceClient();
  const { data, error } = await client.storage.from("course_import_staging").createSignedUploadUrl(storagePath, { upsert: true });
  if (error || !data) {
    console.error(`course-import init failed: ${error?.message}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path: data.path });
}
