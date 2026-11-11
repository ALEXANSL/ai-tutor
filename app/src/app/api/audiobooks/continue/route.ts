import { NextResponse } from "next/server";
import { audioRunning } from "@/lib/audiobooks";
import { validAudioWake } from "@/server/audiobooks/wake-auth";
import { readAudioPart } from "@/server/audiobooks/store";
import { kickAudioPart } from "@/server/audiobooks/wake";
export const maxDuration = 300;
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 2048) return new NextResponse(null, { status: 413 });
  const raw: unknown = await request.json().catch(() => null);
  if (!validAudioWake(raw)) return new NextResponse(null, { status: 401 });
  const part = await readAudioPart(raw.familyId, raw.id);
  if (part && part.token === raw.token && audioRunning(part)) kickAudioPart(raw.familyId, raw.id);
  return new NextResponse(null, { status: 202 });
}
