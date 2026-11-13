import "server-only";
import { unzipSync } from "fflate";
import { forFamily } from "@/server/db/family-scope";
import { getBookMaterialMeta } from "@/server/books/reader";
import { downloadFile, isValidDriveId } from "@/server/drive/google";
import { getDriveToken } from "@/server/drive/service";
import type { Extraction } from "@/server/ingest/text";
import type { AudioRequest, LibraryBook, LibrarySettings } from "@/lib/audiobooks";
import { readLibrarySettings, documentId, defaultLibrarySettings, SETTINGS_TYPE } from "./store";
import { joinIndexedAudioPage, trimAudioParagraph } from "./paragraph-source";
import { sourceParagraphs } from "./text";
export async function libraryBook(familyId: string, id: string): Promise<LibraryBook | null> {
  const meta = await getBookMaterialMeta(familyId, id); if (!meta) return null;
  const settings = await readLibrarySettings(familyId, id);
  const [sections, topics] = await Promise.all([
    forFamily(familyId).select("material_sections", "id,title,page_from,page_to").eq("material_id", id).order("sort_order").limit(500).returns<{ id: string; title: string; page_from: number | null; page_to: number | null }[]>(),
    forFamily(familyId).select("topics", "id,title,page_from,page_to").eq("material_id", id).order("sort_order").order("page_from").limit(1000).returns<{ id: string; title: string; page_from: number | null; page_to: number | null }[]>(),
  ]);
  if (sections.error || topics.error) throw new Error("Не вдалося прочитати зміст.");
  const indexedTopics = (topics.data ?? []).filter(topic => topic.page_from && topic.page_to);
  const paragraphRows = indexedTopics.length ? indexedTopics : (sections.data ?? []).filter(section => section.page_from && section.page_to && /^\s*(?:§|параграф)/iu.test(section.title));
  // Include the next heading's page when adjacent: the selected paragraph may
  // continue above it. The source loader cuts at the actual heading, not a page edge.
  const paragraphs = paragraphRows.map((topic, index) => {
    const next = paragraphRows[index + 1];
    const to = meta.format === "pdf" && next?.page_from && next.page_from >= topic.page_from! && next.page_from <= topic.page_to! + 1 ? next.page_from : topic.page_to!;
    return { id: topic.id, title: topic.title, from: topic.page_from!, to };
  });
  return { id, title: meta.title || meta.name, author: settings.author, format: meta.format, pages: meta.pageCount, settings, paragraphs, chapters: settings.chaptersOverride || settings.chapters.length ? settings.chapters : (sections.data ?? []).filter(s => s.page_from && s.page_to).map(s => ({ title: s.title, from: s.page_from!, to: s.page_to! })) };

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
export function selectedAudioParagraph(request: AudioRequest, book: LibraryBook) {
  if (!request.paragraphId) return null;
  const paragraph = book.paragraphs?.find(item => item.id === request.paragraphId);
  if (!paragraph || request.numbering !== "source" || request.from !== paragraph.from || request.to !== paragraph.to) throw new Error("Параграф або його межі змінилися. Обери його ще раз зі змісту книги.");
  return paragraph;
}
export async function loadAudioSource(familyId: string, request: AudioRequest) {
  if (request.lesson) return (await import("./lesson-source")).readyAudioLessonSource(familyId, request);
  const book = await libraryBook(familyId, request.materialId); if (!book) throw new Error("Книгу не знайдено.");
  const selected = selectedAudioParagraph(request, book);
  const range = physicalRange(request, book);
  const extraction = await originalBookText(familyId, request.materialId, range).catch(error => { if (book.format !== "pdf") throw error; return null; });
  let units = extraction?.units.filter(u => u.page >= range.from && u.page <= range.to) ?? [];
  const readable = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 20;
  const missing = Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i).filter(page => !units.some(unit => unit.page === page && readable(unit.text)));
  let notes = "";
  if (missing.length && book.format === "pdf") {
    const { data, error } = await forFamily(familyId).select("chunks", "page,text,ordinal").eq("material_id", request.materialId).gte("page", range.from).lte("page", range.to).order("ordinal").limit(2001).returns<{ page: number; text: string; ordinal: number }[]>();
    if (error || (data?.length ?? 0) > 2000) throw new Error("Не вдалося прочитати індексований текст. Спробуй коротший параграф або готовий урок.");
    for (const page of missing) {
      const text = joinIndexedAudioPage((data ?? []).filter(chunk => chunk.page === page).map(chunk => chunk.text));
      if (readable(text)) { units = [...units.filter(unit => unit.page !== page), { page, text, locator: null }]; notes = "Частину сторінок відновлено з власного індексованого тексту. Перевір якість розпізнавання перед озвученням."; }
    }
  }
  units.sort((a,b) => a.page - b.page);
  const unreadable = Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i).filter(page => !units.some(unit => unit.page === page && readable(unit.text)));
  if (unreadable.length) throw new Error(`Не вдалося прочитати сторінки ${unreadable.join(", ")}. Для аудіоуроку вибери готовий урок; для дослівного читання потрібен розпізнаний текст книги.`);
  if (selected) {
    const index = book.paragraphs!.findIndex(item => item.id === selected.id);
    const next = book.paragraphs![index + 1];
    try { units = trimAudioParagraph(units, selected.title, next && next.from <= range.to ? next.title : undefined); }
    catch {
      notes = [notes, "Межі параграфа не вдалося визначити достатньо точно. Збережено ВЕСЬ текст вибраних сторінок без скорочень, щоб не втратити твір. Перед озвученням перевір початок і кінець та за потреби прибери сусідню тему в редакторі."].filter(Boolean).join("\n");
    }
  }
  return { book, range, paragraphs: sourceParagraphs(units), notes };
}
