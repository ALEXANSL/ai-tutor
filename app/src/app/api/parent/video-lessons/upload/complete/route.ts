import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { saveVideoLesson } from "@/server/lessons/videoLessons";

/**
 * S47 video-lesson upload, step 2 of 2 — same shape as
 * `/api/parent/books/upload/complete`: a lightweight JSON request (just the
 * storage path the browser already PUT the file to) that persists the
 * `video_lessons` row.
 */
export const dynamic = "force-dynamic";

interface CompleteBody {
  topicId?: unknown;
  storagePath?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
}

export async function POST(request: NextRequest) {
  const { familyId } = await requireParentAccess();
  const body = (await request.json().catch(() => null)) as CompleteBody | null;
  const topicId = typeof body?.topicId === "string" ? body.topicId : null;
  const storagePath = typeof body?.storagePath === "string" ? body.storagePath : null;
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "video/mp4";
  const sizeBytes = typeof body?.sizeBytes === "number" && Number.isFinite(body.sizeBytes) ? body.sizeBytes : 0;
  // The storage path is namespaced `${familyId}/...` by the init route, so a
  // path belonging to another family can never be completed here either.
  if (!topicId || !storagePath || !storagePath.startsWith(`${familyId}/`)) {
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }

  const { data: topic } = await forFamily(familyId).select("topics", "id, subject_id").eq("id", topicId).maybeSingle<{ id: string; subject_id: string }>();
  if (!topic) return NextResponse.json({ error: "failed" }, { status: 404 });

  try {
    const id = await saveVideoLesson(familyId, topicId, topic.subject_id, storagePath, mimeType, sizeBytes);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    console.error(`video-lesson upload complete failed: ${(e as Error).message}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
