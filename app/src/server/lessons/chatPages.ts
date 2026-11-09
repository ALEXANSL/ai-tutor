import "server-only";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { MAX_LESSON_SOURCE_PAGES } from "@/lib/lesson-chat";
import { forFamily } from "@/server/db/family-scope";
import { createServiceClient } from "@/server/supabase/clients";
import type { VisionDocument } from "@/server/ai/types";
import type { LessonVoiceLessonRef } from "@/server/voice/lessonContext";
import { getLiteratureV3BookIndex } from "./literatureV3View";

export const lessonChatAttachmentsSchema = z.object({ printedPages: z.array(z.number().int().min(1).max(10000)).max(MAX_LESSON_SOURCE_PAGES) }).strict();
export class LessonPageError extends Error {}
export async function selectedPdfPages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes);
  if (pages.some(page => !Number.isInteger(page) || page < 1 || page > source.getPageCount())) throw new LessonPageError("Не вдалося знайти потрібну сторінку у PDF.");
  const output = await PDFDocument.create();
  const copied = await output.copyPages(source, pages.map(page => page - 1));
  copied.forEach(page => output.addPage(page));
  return output.save();
}
/** Client supplies printed page numbers only. File paths/package/mapping stay trusted server data. */
export async function resolveChatPages(familyId: string, ref: LessonVoiceLessonRef | undefined, raw: unknown): Promise<{ documents: VisionDocument[]; printedPages: number[]; context: string }> {
  const { printedPages: requested } = lessonChatAttachmentsSchema.parse(raw);
  const printedPages = [...new Set(requested)];
  if (!printedPages.length) return { documents: [], printedPages: [], context: "" };
  if (ref?.kind !== "chapter" || !ref.packageId) throw new LessonPageError("Додавання PDF-сторінок доступне для курсів із віртуальним підручником. Можна вставити текст сторінки у запит.");
  const index = await getLiteratureV3BookIndex(familyId, ref.packageId);
  const entries = printedPages.map(page => index.find(entry => entry.printedPage === page));
  if (entries.some(entry => !entry)) throw new LessonPageError("Вибраної сторінки немає серед завантажених PDF цього підручника.");
  const scope = forFamily(familyId);
  const documents: VisionDocument[] = [];
  const notes: string[] = [];
  let bytesTotal = 0;
  const groups = new Map<string, { printed: number; pdf: number }[]>();
  entries.forEach((entry, index) => { if (entry) groups.set(entry.assetId, [...(groups.get(entry.assetId) ?? []), { printed: printedPages[index]!, pdf: entry.bundlePdfPage }]); });
  for (const [assetId, pages] of groups) {
    const { data: asset, error } = await scope.select("literature_v3_assets", "storage_path,mime_type,kind").eq("id", assetId).eq("package_id", ref.packageId).eq("kind", "lesson_pdf").maybeSingle<{ storage_path: string | null; mime_type: string; kind: string }>();
    if (error || !asset?.storage_path || asset.kind !== "lesson_pdf" || asset.mime_type !== "application/pdf") throw new LessonPageError("PDF-джерело сторінки недоступне.");
    const { data: blob, error: fileError } = await createServiceClient().storage.from("course_assets").download(asset.storage_path);
    if (fileError || !blob || blob.size > 20 * 1024 * 1024) throw new LessonPageError("Не вдалося завантажити PDF сторінки або файл перевищує 20 МБ. Встав текст сторінки у запит.");
    const bytes = await selectedPdfPages(new Uint8Array(await blob.arrayBuffer()), pages.map(page => page.pdf));
    bytesTotal += bytes.byteLength;
    if (bytesTotal > 8 * 1024 * 1024) throw new LessonPageError("Вибрані сторінки перевищують 8 МБ. Додай одну сторінку або встав її текст.");
    documents.push({ mediaType: "application/pdf", data: Buffer.from(bytes).toString("base64") });
    notes.push(`Доданий PDF ${documents.length}: ${pages.map((page, index) => `сторінка PDF ${index + 1} = друкована сторінка підручника ${page.printed}`).join("; ")}.`);
  }
  return { documents, printedPages, context: `ДЖЕРЕЛО: вибрані сторінки підручника поточного курсу.\n${notes.join("\n")}\nІнші сторінки оригінальних PDF не передані. Номери для посилань — друковані номери підручника.` };
}
