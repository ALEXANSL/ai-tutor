import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { normalizeText, type Extraction } from "./text";

/** PDF text extraction page by page (ADR-008: unpdf / pdf.js, serverless build). */
export async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  // pdf.js may detach the buffer it is given — pass a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  let title: string | null = null;
  try {
    const meta = await getMeta(pdf);
    const t = typeof meta.info?.Title === "string" ? meta.info.Title.trim() : "";
    title = t || null;
  } catch {
    title = null;
  }
  const units = text.map((t, i) => ({ page: i + 1, locator: null, text: normalizeText(t) }));
  return {
    format: "pdf",
    units,
    pageCount: totalPages,
    charCount: units.reduce((n, u) => n + u.text.length, 0),
    title,
    toc: [],
  };
}
