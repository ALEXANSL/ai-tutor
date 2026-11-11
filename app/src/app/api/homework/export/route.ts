import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { readHomework } from "@/server/homework/store";
import { exportHomework } from "@/server/homework/export";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const { familyId } = await requireLessonAccess();
  try {
    const params = new URL(request.url).searchParams;
    const id = z.string().uuid().parse(params.get("id")); const format = z.enum(["docx", "pptx"]).parse(params.get("format"));
    const actor = await voiceActor(familyId); const work = await readHomework(familyId, actor.child.id, id);
    if (!work) return NextResponse.json({ message: "Роботу не знайдено." }, { status: 404 });
    const bytes = await exportHomework(work, format);
    const mime = format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    const filename = `${work.result!.artifact!.title.replace(/[\x00-\x1f/\\:"<>|?*]/g, "_").slice(0, 90)}.${format}`;
    return new Response(bytes as BodyInit, { headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="homework.${format}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { unstable_rethrow(error); return NextResponse.json({ message: error instanceof Error ? error.message : "Не вдалося підготувати файл." }, { status: 400 }); }
}
