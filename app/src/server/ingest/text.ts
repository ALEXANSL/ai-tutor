/**
 * Pure text helpers of the ingest pipeline (ADR-008): normalisation, scan
 * detection and chunking. No I/O — unit-tested on generated fixtures.
 */

/** One extracted unit: a PDF page, or an EPUB chapter (page = chapter number). */
export interface ExtractedUnit {
  page: number;
  /** EPUB: chapter title shown instead of a page number; PDF: null. */
  locator: string | null;
  text: string;
}

export interface Extraction {
  format: "pdf" | "epub";
  units: ExtractedUnit[];
  /** PDF pages or EPUB chapters. */
  pageCount: number;
  charCount: number;
  title: string | null;
  /** EPUB table of contents (chapter titles in reading order). */
  toc: string[];
}

export function normalizeText(raw: string): string {
  return (
    raw
      .replace(/\u0000/g, "") // Postgres text cannot hold NUL
      .replace(/­/g, "") // soft hyphen
      .replace(/\r\n?/g, "\n")
      // words split by a line-end hyphen: "дро-\nби" -> "дроби"
      .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
      .split("\n")
      .map((line) => line.replace(/[ \t \f\v]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Letters and digits only — whitespace and punctuation do not count as "text". */
export function meaningfulChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** Thresholds for "scan without a text layer" (US-2.2 KP-3, D-9). */
export const SCAN_MIN_CHARS_PER_PAGE = 40;
export const SCAN_MAX_TEXT_PAGE_SHARE = 0.1;

/**
 * A PDF is treated as a scan when (almost) no page has a real text layer:
 * ≤ 10 % of pages carry ≥ 40 letters/digits. Mixed books (a few scanned
 * illustrations) are still indexed.
 */
export function looksLikeScan(units: Pick<ExtractedUnit, "text">[]): boolean {
  if (units.length === 0) return true;
  const withText = units.filter((u) => meaningfulChars(u.text) >= SCAN_MIN_CHARS_PER_PAGE).length;
  return withText / units.length <= SCAN_MAX_TEXT_PAGE_SHARE;
}

export interface Chunk {
  ordinal: number;
  page: number;
  locator: string | null;
  text: string;
}

export interface ChunkOptions {
  /** ≈ 800 tokens of Ukrainian text (ADR-008). */
  maxChars: number;
  overlapChars: number;
  /** A tail shorter than this is merged into the previous chunk of the unit. */
  minTailChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 2000, overlapChars: 200, minTailChars: 300 };

function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.match(/[^.!?…]+[.!?…]+["»”)]*\s*|[^.!?…]+$/gu) ?? [paragraph];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur) out.push(cur.trim());
      cur = "";
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars).trim());
      continue;
    }
    if ((cur + s).length > maxChars) {
      out.push(cur.trim());
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function tail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return chars <= 0 ? "" : text;
  const cut = text.slice(-chars);
  const space = cut.search(/\s/);
  return (space >= 0 ? cut.slice(space) : cut).trim();
}

/**
 * Splits units into fragments of ≤ maxChars (+ overlap) that never cross a
 * page/chapter boundary, so every fragment has an exact page for citations.
 */
export function chunkUnits(units: ExtractedUnit[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const chunks: Chunk[] = [];
  for (const unit of units) {
    const text = unit.text.trim();
    if (meaningfulChars(text) === 0) continue;
    const pieces = text
      .split(/\n{2,}/)
      // Single line breaks are kept: headings stay recognisable for the structure step.
      .flatMap((p) => splitLong(p.trim(), options.maxChars - options.overlapChars));
    const unitChunks: string[] = [];
    let cur = "";
    for (const piece of pieces) {
      if (!piece) continue;
      if (cur && cur.length + 1 + piece.length > options.maxChars - options.overlapChars) {
        unitChunks.push(cur);
        cur = piece;
      } else cur = cur ? `${cur}\n${piece}` : piece;
    }
    if (cur) {
      const prev = unitChunks.at(-1);
      if (prev && cur.length < options.minTailChars && prev.length + 1 + cur.length <= options.maxChars) {
        unitChunks[unitChunks.length - 1] = `${prev}\n${cur}`;
      } else unitChunks.push(cur);
    }
    unitChunks.forEach((body, i) => {
      const overlap = i > 0 ? tail(unitChunks[i - 1]!, options.overlapChars) : "";
      chunks.push({
        ordinal: chunks.length,
        page: unit.page,
        locator: unit.locator,
        text: overlap ? `${overlap} ${body}` : body,
      });
    });
  }
  return chunks;
}
