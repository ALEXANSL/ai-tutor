import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";
import { createServiceClient } from "@/server/supabase/clients";

/**
 * S35 import, step 1 of 2 — same signed-upload-URL mechanism as S34's
 * `/api/parent/course-import/init` (see that route's doc comment for the
 * full Vercel body-size-limit reasoning), but accepting `.json` (the
 * package's `public/course.json`/`private/teacher.json`, each uploaded
 * through its own call to this route) or `.zip` (an optional figures
 * archive for the 35 assets) instead of only `.zip`.
 */
export const dynamic = "force-dynamic";

interface InitBody {
  fileName?: unknown;
  size?: unknown;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").trim();
  return (cleaned || "upload").slice(0, 200);
}

export async function POST(request: NextRequest) {
  const { familyId } = await requireParentAccess();
  const body = (await request.json().catch(() => null)) as InitBody | null;
  const fileName = typeof body?.fileName === "string" ? body.fileName : "upload.json";
  const declaredSize = typeof body?.size === "number" && Number.isFinite(body.size) ? body.size : null;

  if (!/\.(json|zip)$/i.test(fileName)) {
    return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  }
  if (declaredSize != null && declaredSize > MAX_COURSE_ZIP_BYTES) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  const storagePath = `${familyId}/${randomUUID()}-${sanitizeFileName(fileName)}`;
  const client = createServiceClient();
  const { data, error } = await client.storage.from("course_import_staging").createSignedUploadUrl(storagePath, { upsert: true });
  if (error || !data) {
    console.error(`math-course-v2-import init failed: ${error?.message}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path: data.path });
}
