import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { MAX_VIDEO_LESSON_BYTES } from "@/lib/upload-limits";
import { createServiceClient } from "@/server/supabase/clients";

/**
 * S47 video-lesson upload, step 1 of 2 — same signed-upload-URL shape as
 * `/api/parent/course-import/init` (see that route's doc comment for why):
 * a JSON-only request opens a Supabase Storage signed upload URL in the
 * private `video_lessons` bucket, so the (potentially hundreds-of-MB)
 * video file bytes never touch our Vercel function.
 */
export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set(["video/mp4", "video/webm", "video/quicktime"]);

interface InitBody {
  topicId?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  size?: unknown;
}

export async function POST(request: NextRequest) {
  const { familyId } = await requireParentAccess();
  const body = (await request.json().catch(() => null)) as InitBody | null;
  const topicId = typeof body?.topicId === "string" ? body.topicId : null;
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
  const size = typeof body?.size === "number" && Number.isFinite(body.size) ? body.size : null;
  if (!topicId) return NextResponse.json({ error: "failed" }, { status: 400 });

  const { data: topic } = await forFamily(familyId).select("topics", "id, subject_id").eq("id", topicId).maybeSingle<{ id: string; subject_id: string }>();
  if (!topic) return NextResponse.json({ error: "failed" }, { status: 404 });

  if (!ALLOWED_MIME.has(mimeType)) return NextResponse.json({ error: "unsupported_type" }, { status: 415 });
  if (size != null && size > MAX_VIDEO_LESSON_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  const storagePath = `${familyId}/${topicId}-${randomUUID()}.mp4`;
  const client = createServiceClient();
  const { data, error } = await client.storage.from("video_lessons").createSignedUploadUrl(storagePath, { upsert: true });
  if (error || !data) {
    console.error(`video-lesson upload init failed: ${error?.message}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path: data.path, subjectId: topic.subject_id });
}
