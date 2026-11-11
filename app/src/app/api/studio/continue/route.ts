import { NextResponse } from "next/server";
import { validStudioWake } from "@/server/studio/wake-auth";
import { readStudioProject } from "@/server/studio/store";
import { studioActive } from "@/lib/studio";
import { kickStudio } from "@/server/studio/wake";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 2000) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!validStudioWake(body)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await readStudioProject(body.familyId, body.projectId);
  if (!project || project.token !== body.token || !studioActive(project.state)) return NextResponse.json({ accepted: false }, { status: 202 });
  kickStudio(body.familyId, body.projectId); return NextResponse.json({ accepted: true }, { status: 202 });
}
