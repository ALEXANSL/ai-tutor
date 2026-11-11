import "server-only";
import { getDocumentProxy } from "unpdf";
import { normalizeText, type Extraction } from "@/server/ingest/text";
interface TextItem { str: string; transform: number[]; hasEOL?: boolean; width?: number; }
/** Preserve line/paragraph boundaries so captions and running headers can be reviewed separately. */
export function pdfAudioLines(items: TextItem[]) {
  const lines: { text: string; y: number }[] = []; let text = "", y: number | null = null, endX: number | null = null;
  const flush = () => { if (text.trim()) lines.push({ text: text.trim(), y: y ?? 0 }); text = ""; endX = null; };
  for (const item of items) {
    const iy = item.transform[5] ?? 0;
    if (y !== null && Math.abs(iy - y) > 2) flush();
    const gap = endX === null ? 0 : (item.transform[4] ?? 0) - endX;
    y = iy; text += `${text && gap > 1 ? " " : ""}${item.str}`; endX = (item.transform[4] ?? 0) + (item.width ?? 0);
    if (item.hasEOL) { flush(); y = null; }
  }
  flush();
  const gaps = lines.slice(1).map((line, i) => Math.abs(line.y - lines[i]!.y)).filter(gap => gap > 2).sort((a, b) => a - b);
  const usual = gaps[Math.floor(gaps.length / 2)] ?? 14;
  const technical = (value: string) => /^(?:\d{1,5}|(?:Мал\.|Рис\.|Ілюстрація|Fig\.|Figure)\s*\d.*)$/iu.test(value);
  return normalizeText(lines.map((line, i) => {
    const separate = i > 0 && (Math.abs(line.y - lines[i - 1]!.y) > usual * 1.35 || technical(line.text) || technical(lines[i - 1]!.text));
    return `${i ? separate ? "\n\n" : "\n" : ""}${line.text}`;
  }).join(""));
}
export async function extractAudioPdf(bytes: Uint8Array, range: { from: number; to: number }): Promise<Extraction> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    if (range.from < 1 || range.to > pdf.numPages) throw new Error("Сторінки виходять за межі PDF.");
    const units: Extraction["units"] = [];
    for (let n = range.from; n <= range.to; n++) {
      const page = await pdf.getPage(n); const content = await page.getTextContent();
      const items = content.items.filter((item): item is typeof item & TextItem => "str" in item && "transform" in item);
      units.push({ page: n, locator: null, text: pdfAudioLines(items) }); page.cleanup();
    }
    return { format: "pdf", units, pageCount: pdf.numPages, charCount: units.reduce((n, u) => n + u.text.length, 0), title: null, toc: [] };
  } finally { await pdf.cleanup(); }
}
