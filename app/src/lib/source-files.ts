/** Shared upload contract; safe in browser bundles. */
export const SOURCE_MIME = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpeg: "image/jpeg",
} as const;
export type SourceFileFormat = keyof typeof SOURCE_MIME;
export const SOURCE_FILE_ACCEPT = ".pdf,.epub,.docx,.pptx,.txt,.text,.md,.png,.jpg,.jpeg";
export const SOURCE_FILE_LABEL = "PDF, EPUB, DOCX, PPTX, TXT, PNG або JPEG";
export function sourceFileFormat(file: { name: string; mimeType: string }): SourceFileFormat | null {
  const ext = file.name.toLowerCase().split(".").pop();
  const extension = ext === "jpg" ? "jpeg" : ext === "text" ? "txt" : ext;
  const byExtension = extension && Object.hasOwn(SOURCE_MIME, extension) ? extension as SourceFileFormat : null;
  const mime = file.mimeType.toLowerCase().split(";")[0]!.trim();
  const byMime = (Object.entries(SOURCE_MIME).find(([, value]) => value === mime)?.[0] ?? null) as SourceFileFormat | null;
  if (byMime) return byExtension && byExtension !== byMime ? null : byMime;
  if (!mime || ["application/octet-stream", "application/zip", "application/x-zip-compressed"].includes(mime)) return byExtension;
  return null;
}
/** `manual` is the existing prestructured index representation; MIME keeps the original format. */
export function storedSourceFormat(format: SourceFileFormat): "pdf" | "epub" | "manual" {
  return format === "pdf" || format === "epub" ? format : "manual";
}
