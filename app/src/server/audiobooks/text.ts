import { createHash } from "node:crypto";
import { exclusionSchema, type AudioParagraph } from "@/lib/audiobooks";
import type { ExtractedUnit } from "@/server/ingest/text";
export function sourceParagraphs(units: ExtractedUnit[]): AudioParagraph[] {
  const result: AudioParagraph[] = [];
  for (const unit of units) {
    const text = unit.text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/\u00ad/g, "").replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2");
    // No word rewriting, no removal of repeated literary passages or numbers.
    for (const paragraph of text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)) {
      result.push({ id: result.length, page: unit.page, text: paragraph });
    }
  }
  if (result.length > 500 || result.reduce((n, p) => n + p.text.length, 0) > 60000) throw new Error("Обсяг завеликий. Підготуй коротший уривок (до 60 000 символів).");
  if (!result.length) throw new Error("Не знайдено тексту для озвучення.");
  return result;
}
export function preparedManuscript(paragraphs: AudioParagraph[], raw: unknown, preserveLines: boolean) {
  const result = exclusionSchema.parse(raw); const ids = new Set<number>();
  for (const item of result.omitted) {
    const paragraph = paragraphs.find(p => p.id === item.id);
    if (!paragraph || ids.has(item.id)) throw new Error("Некоректні посилання редактора. Перевір джерело.");
    // Reject large content removals: doubtful material stays for a human preview.
    if (paragraph.text.length > 350 || (item.reason === "page_number" && !/^\s*[-–—]?\s*\d{1,5}\s*[-–—]?\s*$/u.test(paragraph.text))) throw new Error("Редактор запропонував завелике вилучення. Вибери коротший уривок або збережи весь текст.");
    ids.add(item.id);
  }
  const kept = paragraphs.filter(p => !ids.has(p.id));
  const text = kept.map(p => preserveLines ? p.text : p.text.replace(/\s*\n\s*/g, " ")).join("\n\n");
  if (text.length < 80 || text.length < paragraphs.reduce((n, p) => n + p.text.length, 0) * 0.65) throw new Error("Редактор вилучив забагато тексту. Потрібна перевірка.");
  return { text, omitted: result.omitted, notes: result.notes };
}
/** Exact complete text; split without duplication, truncation or dropping whitespace. */
export function splitAudioText(text: string, limit = 2800): string[] {
  const result: string[] = []; let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = Math.max(remaining.lastIndexOf(". ", limit), remaining.lastIndexOf("? ", limit), remaining.lastIndexOf("! ", limit)) + 1;
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit);
    if (cut < 1) cut = limit;
    // Keep surrogate pairs intact when a long unbroken string is encountered.
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1] ?? "")) cut--;
    result.push(remaining.slice(0, cut)); remaining = remaining.slice(cut);
  }
  if (remaining) result.push(remaining); return result;
}
export const audioHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function audioSegmentKey(text: string, model: string, voice: string) { return audioHash(JSON.stringify(["audiobook-v1", model, voice, text])); }
