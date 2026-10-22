import { NextResponse } from "next/server";
import { requireLessonAccess } from "@/server/auth/guards";
import { voiceActor, voiceTurn } from "@/server/voice/service";
import { sameOrigin, voiceError } from "@/server/voice/http";
export const maxDuration = 180;
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "origin" }, { status: 403 });
  const { familyId } = await requireLessonAccess();
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 1_100_000) throw new Error("voice_audio");
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) throw new Error("voice_audio");
    return NextResponse.json(await voiceTurn(await voiceActor(familyId), String(form.get("id")), audio));
  } catch (error) { return voiceError(error); }
}
