import { extractEpub } from "./extract-epub";
import { extractPdf } from "./extract-pdf";
import type { Extraction } from "./text";

/**
 * SourceExtractor registry by file format (ADR-017 (б)). A new format
 * (DOCX, OCR of scans…) is a new entry, the pipeline does not change.
 */
/**
 * 'manual' (ADR-031 Частина 3): a materials row produced by the batch
 * ZIP-import commit (`manual-batch-pipeline.ts`) — its text/structure comes
 * straight from the parent's `index.json`/`pages.jsonl`, never from
 * `ingest.extract`/`sourceExtractors`. It is a recognised DB value (see the
 * migration's CHECK constraint) but deliberately has NO entry below —
 * `runExtract` in `pipeline.ts` guards against ever indexing into this map
 * with it.
 */
export type SourceFormat = "pdf" | "epub" | "manual";
export type SourceExtractor = (bytes: Uint8Array) => Promise<Extraction>;

export const sourceExtractors: Record<"pdf" | "epub", SourceExtractor> = {
  pdf: extractPdf,
  epub: extractEpub,
};
