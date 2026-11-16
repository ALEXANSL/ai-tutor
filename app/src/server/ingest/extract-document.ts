import { unzipSync, strFromU8 } from "fflate";
import type { SourceFileFormat } from "@/lib/source-files";
import { decodeEntities } from "./extract-epub";
import { normalizeText, type ExtractedUnit, type Extraction } from "./text";

export class DocumentExtractionError extends Error {}
export type DocumentExtraction = Extraction & { warnings: string[] };
const MAX_XML = 16 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;

/** Read bounded OOXML text parts only; never run embedded objects or resolve external relationships. */
function officeParts(bytes: Uint8Array, format: "docx" | "pptx") {
  let total = 0, entries = 0;
  try {
    const files = unzipSync(bytes, { filter: entry => {
      if (++entries > 20000) throw new DocumentExtractionError("Забагато елементів в архіві документа.");
      const wanted = format === "docx" ? /^word\/(?:document|footnotes|endnotes)\.xml$/.test(entry.name) : /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)$/.test(entry.name);
      if (!wanted) return false;
      total += entry.originalSize;
      if (entry.originalSize > MAX_XML || total > MAX_TOTAL) throw new DocumentExtractionError("Текстова частина документа завелика. Розділи документ.");
      return true;
    } });
    return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError("Не вдалося прочитати документ. Потрібен справжній DOCX або PPTX без пароля.");
  }
}
function attribute(tag: string, name: string) {
  return decodeEntities(tag.match(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`))?.[1] ?? "");
}
/** XML run boundaries do not insert spaces: a Word word may span several runs. */
function richText(xml: string, prefix: "w" | "a") {
  const expression = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${prefix}:t>|<${prefix}:(tab|br|cr)\\b[^>]*\\/?>`, "g");
  return [...xml.matchAll(expression)].map(match => match[1] !== undefined ? decodeEntities(match[1]) : match[2] === "tab" ? "\t" : "\n").join("");
}
function finish(units: ExtractedUnit[], warnings: string[]): DocumentExtraction {
  if (units.length > 10000) throw new DocumentExtractionError("У документі понад 10 000 частин. Розділи його.");
  const charCount = units.reduce((sum, unit) => sum + unit.text.length, 0);
  if (!charCount) throw new DocumentExtractionError("У файлі немає читабельного тексту. Якщо це скан, завантаж PDF або фото сторінок для розпізнавання.");
  return { format: "manual", units, pageCount: units.length, charCount, title: null, toc: units.map(unit => unit.locator).filter((value): value is string => !!value), warnings };
}
export async function extractDocument(bytes: Uint8Array, format: SourceFileFormat): Promise<DocumentExtraction> {
  if (format === "txt" || format === "md") {
    let text: string;
    try {
      const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
      text = new TextDecoder(utf16, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    } catch { throw new DocumentExtractionError("Збережи текстовий файл у кодуванні UTF-8 або UTF-16."); }
    if (/\u0000/.test(text)) throw new DocumentExtractionError("Це двійковий файл, а не текстовий документ.");
    const parts = text.split(/\f/);
    const units: ExtractedUnit[] = [];
    for (const part of parts) {
      // Stable text parts, not invented printed page numbers; do not truncate large files.
      for (let offset = 0; offset < part.length;) {
        let end = Math.min(offset + 12000, part.length);
        if (end < part.length) {
          const boundary = Math.max(part.lastIndexOf("\n", end), part.lastIndexOf(" ", end));
          if (boundary > offset + 6000) end = boundary + 1;
          else if (/[\uD800-\uDBFF]/.test(part[end - 1]!)) end--;
        }
        units.push({ page: units.length + 1, locator: `Частина тексту ${units.length + 1}`, text: normalizeText(part.slice(offset, end)) });
        offset = end;
      }
    }
    return finish(units, ["Номери частин текстового файла не є сторінками друкованої книги."]);
  }
  if (format !== "docx" && format !== "pptx") throw new DocumentExtractionError("Для цього формату потрібен інший спосіб розпізнавання.");
  const parts = officeParts(bytes, format);
  const warnings = ["Витягнуто текст і таблиці. Вбудовані ілюстрації, діаграми, спеціальні математичні формули та текст усередині зображень не розпізнавалися; потрібне зображення можна додати окремим файлом."];
  if (format === "docx") {
    const document = parts["word/document.xml"];
    if (!document || !/<w:document\b/.test(document)) throw new DocumentExtractionError("У DOCX немає основного документа.");
    const units: ExtractedUnit[] = [];
    let title = "Початок документа", paragraphs: string[] = [];
    const flush = () => { if (paragraphs.length) units.push({ page: units.length + 1, locator: title, text: paragraphs.join("\n\n") }); paragraphs = []; };
    // Walk paragraph/table blocks in source order. Tables retain explicit cell separators.
    const body = document.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1] ?? "";
    for (const match of body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
      const block = match[0];
      if (block.startsWith("<w:tbl")) {
        const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(row => [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(cell => [...cell[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(p => richText(p[0], "w")).join(" / ")).join(" | "));
        if (rows.length) paragraphs.push(rows.join("\n"));
      } else {
        const text = normalizeText(richText(block, "w"));
        if (!text) continue;
        if (/<w:pStyle\b[^>]*w:val=["'](?:Heading[1-6]|Title|Заголовок[1-6])["']/i.test(block)) { flush(); title = text; }
        paragraphs.push(text);
      }
    }
    flush();
    for (const name of ["word/footnotes.xml", "word/endnotes.xml"]) if (parts[name]) {
      const notes = [...parts[name]!.matchAll(/<w:(?:footnote|endnote)\b[^>]*>[\s\S]*?<\/w:(?:footnote|endnote)>/g)].filter(match => !/w:type=["'](?:separator|continuationSeparator)["']/.test(match[0])).map(match => normalizeText(richText(match[0], "w"))).filter(Boolean);
      if (notes.length) units.push({ page: units.length + 1, locator: "Примітки документа", text: notes.join("\n\n") });
    }
    warnings.push("DOCX поділено за заголовками; номери частин не є номерами сторінок Word.");
    return finish(units, warnings);
  }
  const presentation = parts["ppt/presentation.xml"], relations = parts["ppt/_rels/presentation.xml.rels"];
  if (!presentation || !relations) throw new DocumentExtractionError("У PPTX немає структури презентації.");
  const byId = new Map<string, string>();
  for (const match of relations.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const tag = match[0], target = attribute(tag, "Target");
    if (attribute(tag, "TargetMode") === "External") continue;
    if (/^\/?(?:ppt\/)?slides\/slide\d+\.xml$/.test(target)) byId.set(attribute(tag, "Id"), target.startsWith("/ppt/") ? target.slice(1) : target.startsWith("ppt/") ? target : `ppt/${target}`);
  }
  const units: ExtractedUnit[] = [];
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*\/?\s*>/g)) {
    const path = byId.get(attribute(match[0], "r:id"));
    if (!path || !parts[path]) throw new DocumentExtractionError("Не вдалося прочитати один зі слайдів. Перезбережи презентацію як PPTX.");
    const slide = parts[path]!;
    const paragraphs = [...slide.matchAll(/<a:p\b[\s\S]*?<\/a:p>|<a:tr\b[\s\S]*?<\/a:tr>/g)].map(match => {
      if (match[0].startsWith("<a:tr")) return [...match[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map(cell => [...cell[0].matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map(p => richText(p[0], "a")).join(" / ")).join(" | ");
      return richText(match[0], "a");
    }).map(normalizeText).filter(Boolean);
    const page = units.length + 1;
    if (!paragraphs.length) warnings.push(`Слайд ${page}: текстового шару немає; вміст зображення не розпізнано.`);
    units.push({ page, locator: `Слайд ${page}`, text: paragraphs.join("\n\n") });
  }
  return finish(units, [...new Set(warnings)]);
}
