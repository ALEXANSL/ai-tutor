import { NextResponse } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { extractStudioFileAction } from "@/app/actions/studio";
/** Small files use a bounded multipart route, bypassing Server Actions' default 1MB limit. Larger books use the existing direct library upload. */
export const maxDuration = 180;
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  await requireParentAccess();
  if (Number(request.headers.get("content-length") ?? 0) > 4 * 1024 * 1024) return NextResponse.json({ status: "error", message: "Файл завеликий. Додай книгу через бібліотеку." }, { status: 413 });
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ status: "error", message: "Не вдалося прочитати файл." }, { status: 400 });
  const result = await extractStudioFileAction(form);
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 400 });
}
