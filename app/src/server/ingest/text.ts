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

/**
 * BUG: verbatim excerpts (e.g. the BUG-011 safe fallback block) used to be
 * cut with a hard `text.slice(0, maxChars)`, which can land mid-sentence or
 * even mid-word ("...незламній волі до") — a visible, unprofessional defect
 * for a child reading it. This truncates at the last complete sentence
 * within `maxChars` instead, falling back to a paragraph break and then a
 * word boundary (marked with an ellipsis) when no sentence end is close
 * enough to be worth keeping.
 */
/**
 * BUG (P0, 2026-09-30, real child-facing screenshot): a textbook list item
 * ("3. Укажи дії...\n4. Порівняй...") formats its item numbers exactly like
 * a sentence — a bare digit run followed by a period. When that "4." lands
 * on the boundary of the truncation window, the old sentence-end regex
 * happily treated it as a legitimate sentence end and cut the excerpt right
 * there, leaving a naked list-item number ("...самостійно\n4.") as the last
 * visible thing a child reads. A genuine sentence end is never JUST a 1-2
 * digit number with nothing else since the start of its line — that shape is
 * only ever a list-item marker, so it must not count as a place to stop.
 */
function isBareListItemNumber(slice: string, matchIndex: number): boolean {
  const lineStart = slice.lastIndexOf("\n", matchIndex - 1) + 1;
  const before = slice.slice(lineStart, matchIndex);
  return /^\s{0,3}\d{1,2}$/.test(before);
}

export function truncateAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const minKeep = maxChars * 0.4;

  const sentenceEnds = [...slice.matchAll(/[.!?…][»”")]*(?=\s|$)/gu)].filter(
    (m) => m.index === undefined || !isBareListItemNumber(slice, m.index),
  );
  const lastSentence = sentenceEnds.at(-1);
  if (lastSentence && lastSentence.index !== undefined) {
    const cut = lastSentence.index + lastSentence[0].length;
    if (cut >= minKeep) return slice.slice(0, cut).trim();
  }

  const paragraphBreak = slice.lastIndexOf("\n\n");
  if (paragraphBreak >= minKeep) return slice.slice(0, paragraphBreak).trim();

  const wordBoundary = slice.search(/\s+\S*$/);
  const base = wordBoundary > 0 ? slice.slice(0, wordBoundary) : slice;
  return `${base.trim()}…`;
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
