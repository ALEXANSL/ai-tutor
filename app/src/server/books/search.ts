/**
 * PDF reader free-text / numbering search (Alex, 2026-10-02): search over the
 * text the ingest pipeline already extracted and stored in `chunks`
 * (`extract-pdf.ts` -> `chunkUnits`, ADR-008/031) — no AI call, no
 * re-parsing of the PDF for every search, $0 marginal cost.
 *
 * Pure logic, no I/O — the `chunks` rows are fetched by the API route
 * (`app/api/book/[materialId]/search/route.ts`) and handed in here so this
 * stays unit-testable without a database.
 */

export interface SearchableChunk {
  /** PDF page (ADR-008). Null only for the rare empty/undetermined unit — skipped. */
  page: number | null;
  /** Printed-page label when it differs from the PDF page (manual import, ADR-031 §3.5). */
  locator: string | null;
  text: string;
}

export interface SearchHit {
  page: number;
  /** Printed page label, if the material has one distinct from the PDF page. */
  locator: string | null;
  snippet: string;
}

export interface NumberQuery {
  /** The textbook's own label for this kind of numbered item, as shown back to the user. */
  label: string;
  number: string;
}

/**
 * The textbook numbering conventions already in use by `literature-schema.ts`
 * (`questionItemSchema.number`, e.g. "1", "2а", "12") and by the source
 * material's own headings ("Тема N", "§N") — matched here as plain regex
 * over raw page text, never invented beyond what the PO's real books use.
 * Order matters: longer/more specific keywords are tried before shorter
 * ones that could be a prefix of another (none currently overlap, but kept
 * explicit rather than relying on object key order).
 */
const KEYWORDS: { re: RegExp; label: string; stem: string }[] = [
  { re: /^параграф\.?\s*/iu, label: "§", stem: "параграф" },
  { re: /^§\s*/u, label: "§", stem: "§" },
  { re: /^тем[аи]?\.?\s+/iu, label: "Тема", stem: "тем" },
  { re: /^завданн(?:я|ю)\.?\s+/iu, label: "завдання", stem: "завдан" },
  { re: /^задач[аі]?\.?\s+/iu, label: "задача", stem: "задач" },
  { re: /^вправ[аи]?\.?\s+/iu, label: "вправа", stem: "вправ" },
  { re: /^запитанн(?:я|ю)?\.?\s+/iu, label: "запитання", stem: "запитан" },
  { re: /^пункт\.?\s+/iu, label: "пункт", stem: "пункт" },
];

/**
 * "5", "2а", "12" — same shape as the textbook's own verbatim numbering
 * (`number` field). A trailing `\b` would not reliably work here: JS regex
 * word boundaries only recognise ASCII word characters even in unicode
 * mode, so right after a Cyrillic suffix ("2а") there IS a boundary (ASCII
 * digit -> non-word Cyrillic letter), but a GREEDY match that includes the
 * Cyrillic letter then finds NO boundary at end-of-string/before a space
 * (non-word -> non-word) and backtracks to drop the letter — "2а" would
 * silently become "2". A lookahead that rejects a following letter/digit
 * (`AFTER_NUMBER`) is used instead everywhere a boundary after the number
 * is needed, here and in `numberQueryRegex`.
 */
const AFTER_NUMBER = "(?![\\p{L}\\p{N}])";
const NUMBER_RE = new RegExp(`^\\d{1,4}[a-zа-яіїєґ]?${AFTER_NUMBER}`, "iu");

/**
 * Recognises "завдання 5", "§3", "задача 12", "Тема 7" as a structured
 * numbering query instead of free text. Returns null for anything else
 * (including a bare number — that is handled by the separate page-jump
 * input, not text search, since a bare "5" is ambiguous between "page 5"
 * and "item 5").
 */
export function parseNumberQuery(raw: string): NumberQuery | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const { re, label } of KEYWORDS) {
    const m = trimmed.match(re);
    if (!m) continue;
    const rest = trimmed.slice(m[0].length).trim();
    const numMatch = rest.match(NUMBER_RE);
    if (numMatch) return { label, number: numMatch[0] };
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The regex used to find a parsed numbering query inside one page's raw
 * text. Tolerant of the keyword's grammatical endings (Ukrainian nouns
 * decline: "завдання", "завданням", "Завдання:") by matching the stem only,
 * and of a "№"/"." between the keyword and the number, or the number
 * printed as a bare list item ("5. Устами..."), which is how most of the
 * PO's textbooks print exercise numbers in practice (ADR-031 context).
 */
function numberQueryRegex(q: NumberQuery): RegExp {
  const num = escapeRegex(q.number);
  if (q.label === "§") return new RegExp(`§\\s*${num}${AFTER_NUMBER}`, "iu");
  const stem = KEYWORDS.find((k) => k.label === q.label)!.stem;
  // keyword ... number  OR  number as its own list item at a line start
  return new RegExp(`(?:${stem}[а-яіїєґ'ʼ]*\\.?:?\\s*№?\\s*${num}${AFTER_NUMBER})|(?:^\\s*${num}\\.\\s)`, "imu");
}

const SNIPPET_RADIUS = 70;

function buildSnippet(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIndex + matchLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/**
 * Finds every page whose text matches `query`, one hit per page (the first
 * match within that page's chunks). A query recognised as a numbering
 * convention (`parseNumberQuery`) is matched precisely; anything else is a
 * plain case-insensitive substring search over the same already-indexed
 * text, so the same box answers both US cases the PO asked for.
 */
export function searchMaterialText(chunks: SearchableChunk[], query: string): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const numberQuery = parseNumberQuery(trimmed);
  const regex = numberQuery ? numberQueryRegex(numberQuery) : null;
  const needle = trimmed.toLocaleLowerCase("uk");

  const byPage = new Map<number, SearchHit>();
  for (const chunk of chunks) {
    if (chunk.page == null || byPage.has(chunk.page)) continue;
    const text = chunk.text;
    let matchIndex = -1;
    let matchLength = needle.length;
    if (regex) {
      const m = regex.exec(text);
      if (m) {
        matchIndex = m.index;
        matchLength = m[0].length;
      }
    } else {
      matchIndex = text.toLocaleLowerCase("uk").indexOf(needle);
    }
    if (matchIndex < 0) continue;
    byPage.set(chunk.page, {
      page: chunk.page,
      locator: chunk.locator,
      snippet: buildSnippet(text, matchIndex, matchLength),
    });
  }
  return [...byPage.values()].sort((a, b) => a.page - b.page);
}
