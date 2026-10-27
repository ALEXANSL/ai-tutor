/** Presentation hints only: never rewrite quotations, OCR words or narration. */
export function preferredReadingLayout(contentType = "", workForm = ""): "paragraphs" | "lines" {
  return /poem|poetry|verse|ballad|поез|вірш|лірик|балада/iu.test(`${contentType} ${workForm}`) ? "lines" : "paragraphs";
}

/** Advisory only. Spaced columns and embedded superscript glyphs require a
 * check against the source PDF, not automatic reconstruction of sentences. */
export function hasReadingExtractionArtifacts(text: string): boolean {
  return /\S[ \t\u00a0]{6,}\S/u.test(text) || /\p{L}[²³]\p{L}{2,}/u.test(text);
}
