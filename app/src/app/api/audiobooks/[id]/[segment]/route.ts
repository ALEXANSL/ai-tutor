import { NextResponse } from "next/server";
import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { readAudioPart } from "@/server/audiobooks/store";
import { signedAudioUrl } from "@/server/audiobooks/storage";
export const dynamic = "force-dynamic";
/** Only already-published audio; never generates on GET. Storage handles byte Range/streaming. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; segment: string }> }) {
  const { familyId } = await requireLessonAccess(); const { id, segment } = await params;
  if (!z.string().uuid().safeParse(id).success || !/^\d{1,3}$/.test(segment)) return new NextResponse(null, { status: 404 });
  const part = await readAudioPart(familyId, id); const chunk = part?.segments[Number(segment)];
  if (!part || !part.published || part.state !== "ready" || !chunk?.ready) return new NextResponse(null, { status: 404 });
  return NextResponse.redirect(await signedAudioUrl(familyId, id, chunk.key), { status: 307, headers: { "Cache-Control": "private, no-store" } });
}
