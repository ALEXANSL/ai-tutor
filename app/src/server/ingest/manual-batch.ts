import { strFromU8, unzipSync } from "fflate";
import { z } from "zod";
import type { NormalizedSection } from "./structure";
import type { ExtractedUnit } from "./text";

/**
 * ADR-031 Частина 3: parsing of a "batch manual import" ZIP — several
 * subject-folders (`ukr_mova/`, `istoriia/`, …), each with `index.json`
 * (structure) + `pages.jsonl` (page text). Pure, no I/O beyond `unzipSync`
 * on already-downloaded bytes — unit-tested directly.
 *
 * Re-used by BOTH `ingest.manual_batch_preview` (parse only, no DB writes)
 * and `ingest.manual_batch_commit` (parses the SAME zip again — deterministic
 * — instead of trusting a possibly-stale/huge stored copy of the parsed
 * text; see the ADR and `manual-batch-pipeline.ts`).
 */

// ---------------------------------------------------------------------------
// §3.7 — the small, static slug -> subject_code map (never in the DB: a new
// slug from a future export just falls into "no match", not an error).
// ---------------------------------------------------------------------------
export const SUBJECT_SLUG_MAP: Record<string, string> = {
  ukr_mova: "ukrainian_language",
  ukr_literatura: "ukrainian_literature",
  zar_literatura: "foreign_literature",
  istoriia: "history",
  geografiia: "geography",
  // informatyka, pryroda, zdorovia: intentionally absent — no matching
  // subject exists in family-defaults.json today (ADR-031 §3.7); the parent
  // picks "create a new subject" on the confirm screen instead.
};

/** Human name hints for "Створити новий предмет «…»" — never auto-created, only a text-field default (ADR-031 §3.7, risk 2). */
export const NEW_SUBJECT_NAME_HINTS: Record<string, string> = {
  pryroda: "Природознавство",
  zdorovia: "Здоров'я, безпека та добробут",
};

// ---------------------------------------------------------------------------
// §3.2 — index.json / pages.jsonl contract
// ---------------------------------------------------------------------------
const KNOWN_STATUSES = ["text_in_pdf", "image_only", "QR_external_check_pdf"] as const;
type KnownStatus = (typeof KNOWN_STATUSES)[number];
/** §3.3: any status outside the three known ones is treated as "needs manual review", same bucket as QR — never imported silently. */
export type EntryStatus = KnownStatus | "unknown";

export function classifyStatus(raw: string): EntryStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(raw) ? (raw as KnownStatus) : "unknown";
}

const indexEntrySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  section: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v ?? "").trim()),
  title: z.string().transform((v) => v.trim()),
  printed_start: z.union([z.number(), z.null()]).optional(),
  pdf_start: z.number().int(),
  pdf_end: z.number().int(),
  status: z.string(),
});

const pagesLineSchema = z.object({
  pdf_page: z.number().int(),
  printed_page: z.union([z.number(), z.null()]).optional(),
  text: z.string().optional(),
});

export interface ParsedEntry {
  id: string;
  section: string;
  title: string;
  printedStart: number | null;
  pdfStart: number;
  pdfEnd: number;
  status: EntryStatus;
}

export interface ParsedPage {
  pdfPage: number;
  printedPage: number | null;
  text: string;
}

/** Throws on malformed JSON / a shape that does not match the contract at all (§3.2) — the whole folder's `index.json` is either valid or the folder is unusable, no partial parse. */
export function parseIndexJson(raw: string): ParsedEntry[] {
  const arr = z.array(indexEntrySchema).parse(JSON.parse(raw));
  return arr.map((e) => ({
    id: e.id,
    section: e.section,
    title: e.title,
    printedStart: e.printed_start ?? null,
    pdfStart: e.pdf_start,
    pdfEnd: e.pdf_end,
    status: classifyStatus(e.status),
  }));
}

/** One bad line (bad JSON, wrong shape) is dropped, not fatal — mirrors how empty/broken pages already degrade gracefully elsewhere in the ingest pipeline. */
export function parsePagesJsonl(raw: string): ParsedPage[] {
  const out: ParsedPage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = pagesLineSchema.safeParse(obj);
    if (!parsed.success) continue;
    out.push({ pdfPage: parsed.data.pdf_page, printedPage: parsed.data.printed_page ?? null, text: parsed.data.text ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §3.1 — unzip and split into (a) single manifest.json book / (b) batch of
// subject-folders, by CONTENT (never by parent choice or file extension).
// ---------------------------------------------------------------------------
export interface FolderParseResult {
  slug: string;
  entries: ParsedEntry[];
  pages: ParsedPage[];
  /** e.g. "missing_index_json" — the folder is unusable, surfaced in the preview instead of silently skipped. */
  parseErrors: string[];
}

export type ParsedZip = { form: "single_manifest" } | { form: "empty" } | { form: "batch"; folders: FolderParseResult[] };

// §3.1: lessons/*.md and index.csv are human-readable renders of the same
// information already in index.json/pages.jsonl — never read by the
// importer; skipping them while unzipping saves memory/time on a large ZIP.
const SKIPPED_FILE = /(^|\/)lessons\/|(^|\/)index\.csv$/;

export function parseManualBatchZip(bytes: Uint8Array): ParsedZip {
  const files = unzipSync(bytes, { filter: (file) => !SKIPPED_FILE.test(file.name) });
  const names = Object.keys(files);
  // Form (а), Частина 1(Б) — out of scope for this batch-import path; the
  // caller reports it as "not a batch ZIP" rather than guessing.
  if (names.some((n) => n === "manifest.json")) return { form: "single_manifest" };

  const topDirs = new Set<string>();
  for (const n of names) {
    const slash = n.indexOf("/");
    if (slash > 0) topDirs.add(n.slice(0, slash));
  }
  if (topDirs.size === 0) return { form: "empty" };

  const folders: FolderParseResult[] = [];
  for (const slug of [...topDirs].sort()) {
    const parseErrors: string[] = [];
    const idxBytes = files[`${slug}/index.json`];
    const pagesBytes = files[`${slug}/pages.jsonl`];
    let entries: ParsedEntry[] = [];
    let pages: ParsedPage[] = [];
    if (!idxBytes) parseErrors.push("missing_index_json");
    else {
      try {
        entries = parseIndexJson(strFromU8(idxBytes));
      } catch {
        parseErrors.push("invalid_index_json");
      }
    }
    if (!pagesBytes) parseErrors.push("missing_pages_jsonl");
    else pages = parsePagesJsonl(strFromU8(pagesBytes));
    folders.push({ slug, entries, pages, parseErrors });
  }
  return { form: "batch", folders };
}

// ---------------------------------------------------------------------------
// §3.3/§3.7 — per-folder preview summary (stored as `manual_import_batches.plan`).
// ---------------------------------------------------------------------------
export interface FolderPlan {
  slug: string;
  parseOk: boolean;
  parseErrors: string[];
  sectionsCount: number;
  importableCount: number;
  imageOnlyCount: number;
  qrCount: number;
  unknownStatusCount: number;
  /** Titles of QR/unknown-status entries, for "потребує ручної перевірки" listing (§3.3, max 50). */
  needsReviewTitles: string[];
  /** §3.3: the WHOLE folder is scans-only — never imported, no `materials` row at all. */
  wholeFolderRejected: boolean;
  suggestedSubjectCode: string | null;
  suggestedNewSubjectName: string | null;
}

export function buildFolderPlan(folder: FolderParseResult): FolderPlan {
  const { entries } = folder;
  const importable = entries.filter((e) => e.status === "text_in_pdf");
  const imageOnly = entries.filter((e) => e.status === "image_only");
  const needsReview = entries.filter((e) => e.status === "QR_external_check_pdf" || e.status === "unknown");
  const wholeFolderRejected = folder.parseErrors.length === 0 && entries.length > 0 && imageOnly.length === entries.length;
  const sections = new Set(importable.map((e) => e.section || "Без розділу"));
  return {
    slug: folder.slug,
    parseOk: folder.parseErrors.length === 0,
    parseErrors: folder.parseErrors,
    sectionsCount: sections.size,
    importableCount: importable.length,
    imageOnlyCount: imageOnly.length,
    qrCount: entries.filter((e) => e.status === "QR_external_check_pdf").length,
    unknownStatusCount: entries.filter((e) => e.status === "unknown").length,
    needsReviewTitles: needsReview.slice(0, 50).map((e) => e.title),
    wholeFolderRejected,
    suggestedSubjectCode: SUBJECT_SLUG_MAP[folder.slug] ?? null,
    suggestedNewSubjectName: NEW_SUBJECT_NAME_HINTS[folder.slug] ?? null,
  };
}

// ---------------------------------------------------------------------------
// §3.4/§3.5 — commit-time: importable entries of one folder -> sections/
// topics (for `applyManualStructure`) and -> chunkable units.
// ---------------------------------------------------------------------------

/** §3.5: one `material_sections` row per unique `section` (first-seen order), one `topics` row per imported (`text_in_pdf`) entry; page_from/page_to are PDF pages, same convention `chunks.page`/`assign_chunk_structure` already use. */
export function buildSectionsForImport(folder: FolderParseResult): NormalizedSection[] {
  const importable = folder.entries.filter((e) => e.status === "text_in_pdf");
  const order: string[] = [];
  const bySection = new Map<string, ParsedEntry[]>();
  for (const e of importable) {
    const key = e.section || "Без розділу";
    if (!bySection.has(key)) {
      bySection.set(key, []);
      order.push(key);
    }
    bySection.get(key)!.push(e);
  }
  return order.map((title) => {
    const es = bySection.get(title)!;
    return {
      title,
      page_from: Math.min(...es.map((e) => e.pdfStart)),
      page_to: Math.max(...es.map((e) => e.pdfEnd)),
      topics: es.map((e) => ({ title: e.title, page_from: e.pdfStart, page_to: e.pdfEnd })),
    };
  });
}

/** §3.4: only pages covered by at least one IMPORTED entry's `[pdf_start, pdf_end]` become chunks; `locator` carries the printed page (§3.5), never the PDF page. */
export function buildUnitsForImport(folder: FolderParseResult): ExtractedUnit[] {
  const importable = folder.entries.filter((e) => e.status === "text_in_pdf");
  if (importable.length === 0) return [];
  const covered = (page: number) => importable.some((e) => page >= e.pdfStart && page <= e.pdfEnd);
  return folder.pages
    .filter((p) => covered(p.pdfPage))
    .sort((a, b) => a.pdfPage - b.pdfPage)
    .map((p) => ({ page: p.pdfPage, locator: p.printedPage != null ? String(p.printedPage) : null, text: p.text }));
}
