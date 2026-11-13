import { NextResponse } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { recognizeStudioPage } from "@/server/studio/photoSource";
import { extractStudioFileAction } from "@/app/actions/studio";
/** Small files use a bounded multipart route, bypassing Server Actions' default 1MB limit. Larger books use the existing direct library upload. */
export const maxDuration = 180;
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const { familyId } = await requireParentAccess();
  if (Number(request.headers.get("content-length") ?? 0) > 4 * 1024 * 1024) return NextResponse.json({ status: "error", message: "Файл завеликий. Додай книгу через бібліотеку." }, { status: 413 });
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ status: "error", message: "Не вдалося прочитати файл." }, { status: 400 });
  if (form.get("recognize") === "true") {
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ status: "error", message: "Обери файл сторінки." }, { status: 400 });
    try { return NextResponse.json({ status: "ok", ...await recognizeStudioPage(familyId, file) }); }
    catch (error) {
      const known = error instanceof Error && /^(Обери|Підтримуються|Для розпізнавання|Сторінку)/u.test(error.message);
      return NextResponse.json({ status: "error", message: known ? (error as Error).message : "Розпізнавання не підтверджено. Перевір бюджет і налаштування OCR; автоматичного повтору немає." }, { status: 400 });
    }
  }
  const result = await extractStudioFileAction(form);
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 400 });
}
