import { NextResponse } from "next/server";
import { requireLessonAccess } from "@/server/auth/guards";
import { manageVoice, voiceActor } from "@/server/voice/service";
import { sameOrigin, voiceError } from "@/server/voice/http";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "origin" }, { status: 403 });
  const { familyId } = await requireLessonAccess();
  try { return NextResponse.json(await manageVoice(await voiceActor(familyId), await request.json())); }
  catch (error) { return voiceError(error); }
}
