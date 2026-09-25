import { extractEpub } from "./extract-epub";
import { extractPdf } from "./extract-pdf";
import type { Extraction } from "./text";

/**
 * SourceExtractor registry by file format (ADR-017 (б)). A new format
 * (DOCX, OCR of scans…) is a new entry, the pipeline does not change.
 */
export type SourceFormat = "pdf" | "epub";
export type SourceExtractor = (bytes: Uint8Array) => Promise<Extraction>;

export const sourceExtractors: Record<SourceFormat, SourceExtractor> = {
  pdf: extractPdf,
  epub: extractEpub,
};
