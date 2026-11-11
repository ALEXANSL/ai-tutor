import "server-only";
import { unzipSync } from "fflate";
import { forFamily } from "@/server/db/family-scope";
import { getBookMaterialMeta } from "@/server/books/reader";
import { downloadFile, isValidDriveId } from "@/server/drive/google";
import { getDriveToken } from "@/server/drive/service";
import type { Extraction } from "@/server/ingest/text";
import type { AudioRequest, LibraryBook, LibrarySettings } from "@/lib/audiobooks";
import { readLibrarySettings, documentId, defaultLibrarySettings, SETTINGS_TYPE } from "./store";
import { sourceParagraphs } from "./text";
export async function libraryBook(familyId: string, id: string): Promise<LibraryBook | null> {
  const meta = await getBookMaterialMeta(familyId, id); if (!meta) return null;
  const settings = await readLibrarySettings(familyId, id);
  const { data, error } = await forFamily(familyId).select("material_sections", "title,page_from,page_to").eq("material_id", id).order("sort_order").limit(500).returns<{ title: string; page_from: number | null; page_to: number | null }[]>();
  if (error) throw new Error("Не вдалося прочитати зміст.");
  return { id, title: meta.title || meta.name, author: settings.author, format: meta.format, pages: meta.pageCount, settings, chapters: settings.chaptersOverride || settings.chapters.length ? settings.chapters : (data ?? []).filter(s => s.page_from && s.page_to).map(s => ({ title: s.title as string, from: s.page_from as number, to: s.page_to as number })) };
}
async function catalogRows<T>(familyId: string, table: string, columns: string) {
  const rows: T[] = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    let query = forFamily(familyId).select(table, columns);
    if (table === "materials") query = query.is("removed_at", null).neq("status", "removed");
    if (table === "jobs") query = query.eq("type", SETTINGS_TYPE);
    const { data, error } = await query.order("id").range(offset, offset + 499).returns<T[]>();
    if (error) throw new Error("Не вдалося прочитати бібліотеку.");
    rows.push(...(data ?? [])); if (!data || data.length < 500) return rows;
  }
  throw new Error("Бібліотека завелика для цього перегляду.");
}
export async function libraryCatalog(familyId: string, query = ""): Promise<LibraryBook[]> {
  const [materials, settingsRows, sections] = await Promise.all([
    catalogRows<{ id: string; title: string | null; name: string; format: string; page_count: number | null }>(familyId, "materials", "id,title,name,format,page_count"),
    catalogRows<{ id: string; payload: LibrarySettings }>(familyId, "jobs", "id,payload"),
    catalogRows<{ id: string; material_id: string; title: string; page_from: number | null; page_to: number | null; sort_order: number }>(familyId, "material_sections", "id,material_id,title,page_from,page_to,sort_order"),
  ]);
  const settingsById = new Map(settingsRows.map(row => [row.id, row.payload]));
  const sectionsByBook = new Map<string, LibrarySettings["chapters"]>();
  for (const row of sections.sort((a, b) => a.sort_order - b.sort_order)) if (row.page_from && row.page_to) { const list = sectionsByBook.get(row.material_id) ?? []; list.push({ title: row.title, from: row.page_from, to: row.page_to }); sectionsByBook.set(row.material_id, list); }
  const books = materials.map(row => { const settings = settingsById.get(documentId(`${familyId}:library:${row.id}`)) ?? defaultLibrarySettings; return { id: row.id, title: row.title || row.name, format: row.format, pages: row.page_count, author: settings.author, settings, chapters: settings.chaptersOverride || settings.chapters.length ? settings.chapters : sectionsByBook.get(row.id) ?? [] }; });
  const q = query.trim().toLocaleLowerCase("uk"); return books.filter(b => !q || [b.title, b.author, ...b.chapters.map(c => c.title)].join(" ").toLocaleLowerCase("uk").includes(q));
}
export async function originalBookText(familyId: string, id: string, range?: { from: number; to: number }): Promise<Extraction> {
  const meta = await getBookMaterialMeta(familyId, id);
  if (!meta || !["pdf", "epub"].includes(meta.format) || !isValidDriveId(meta.driveFileId)) throw new Error("Для аудіокниги потрібен оригінальний PDF або EPUB у власному Google Drive.");
  const token = await getDriveToken(); const bytes = await downloadFile(meta.driveFileId, await token());
  // Scan archive sizes without decompressing to reject zip bombs before EPUB parsing.
  if (meta.format === "epub") { let expanded = 0, entries = 0; unzipSync(bytes, { filter: file => { expanded += file.originalSize; entries++; if (expanded > 100 * 1024 * 1024 || file.originalSize > 30 * 1024 * 1024 || entries > 10000) throw new Error("EPUB завеликий після розпакування."); return false; } }); }
  // Bytes exist only in this call; no file upload or permanent source copy.
  if (meta.format === "pdf" && range) return (await import("./pdf-source")).extractAudioPdf(bytes, range);
  return meta.format === "epub" ? (await import("@/server/ingest/extract-epub")).extractEpub(bytes) : (await import("@/server/ingest/extract-pdf")).extractPdf(bytes);
}
export function physicalRange(request: Pick<AudioRequest, "from" | "to" | "numbering">, book: LibraryBook) {
  if (request.numbering === "printed" && (book.format !== "pdf" || !book.settings.printedConfirmed)) throw new Error("Спочатку підтвердь відповідність друкованих сторінок і PDF у налаштуваннях книги.");
  const offset = request.numbering === "printed" ? book.settings.printedOffset : 0;
  const from = request.from + offset, to = request.to + offset;
  if (from < 1 || to < from || (book.pages && to > book.pages)) throw new Error("Сторінки виходять за межі книги."); return { from, to };
}
export async function loadAudioSource(familyId: string, request: AudioRequest) {
  const book = await libraryBook(familyId, request.materialId); if (!book) throw new Error("Книгу не знайдено.");
  const range = physicalRange(request, book); const extraction = await originalBookText(familyId, request.materialId, range);
  const units = extraction.units.filter(u => u.page >= range.from && u.page <= range.to);
  if (units.length !== range.to - range.from + 1 || units.some(u => (u.text.match(/\p{L}/gu) ?? []).length < 20)) throw new Error("У вибраному діапазоні є порожні або нерозпізнані сторінки. Звузь діапазон або перевір текстовий шар книги.");
  return { book, range, paragraphs: sourceParagraphs(units) };
}
