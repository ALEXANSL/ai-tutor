import { after, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { sameOrigin } from "@/server/voice/http";
import { homeworkFormatSchema, homeworkView } from "@/lib/homework";
import { homeworkSource } from "@/server/homework/source";
import { homeworkUploads, MAX_HOMEWORK_UPLOAD } from "@/server/homework/uploads";
import { beginHomework, recoverHomework, runHomework } from "@/server/homework/service";
import { readHomework } from "@/server/homework/store";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
const command = z.object({ id: z.string().uuid(), requestId: z.string().uuid(), revision: z.number().int().min(0), question: z.string().trim().min(1).max(20000), format: homeworkFormatSchema, pages: z.array(z.number().int().min(1).max(10000)).max(2), target: z.unknown() }).strict();
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "Онови сторінку перед запитом." }, { status: 403 });
  const { familyId } = await requireLessonAccess();
  try {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_HOMEWORK_UPLOAD + 150000) throw new Error("Файли завеликі. Загальний розмір — до 3 МБ.");
    const form = await request.formData();
    const value = command.parse(JSON.parse(String(form.get("command"))));
    const actor = await voiceActor(familyId);
    const source = await homeworkSource(familyId, actor.child.id, value.target);
    if (value.pages.some(page => !source.pages.includes(page))) throw new Error("Вибрана сторінка недоступна в підручнику цього уроку.");
    const files = form.getAll("files");
    if (files.some(file => !(file instanceof File))) throw new Error("Неправильне вкладення.");
    const uploads = await homeworkUploads(files as File[]);
    const result = await beginHomework(familyId, actor.child.id, value.id, source, { ...value, files: uploads.names });
    if (result.started) after(() => runHomework(familyId, actor.child.id, value.id, value.requestId, source, uploads));
    return NextResponse.json(homeworkView(value.id, result.work), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    unstable_rethrow(error);
    return NextResponse.json({ message: error instanceof z.ZodError ? "Перевір запит, формат і вкладення." : error instanceof Error ? error.message : "Не вдалося надіслати запит. Текст залишився у полі." }, { status: 400 });
  }
}
export async function GET(request: Request) {
  const { familyId } = await requireLessonAccess();
  try {
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
    const actor = await voiceActor(familyId); const found = await readHomework(familyId, actor.child.id, id);
    if (!found) return NextResponse.json({ message: "Роботу не знайдено." }, { status: 404 });
    const work = await recoverHomework(familyId, id, found);
    return NextResponse.json(homeworkView(id, work), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { unstable_rethrow(error); return NextResponse.json({ message: "Не вдалося оновити роботу. Спробуй ще раз." }, { status: 400 }); }
}
