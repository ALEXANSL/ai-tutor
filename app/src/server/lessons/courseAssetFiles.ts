import "server-only";

function normalizedPath(path: string): string | null {
  if (!path || /\0|^[a-z][a-z\d+.-]*:|^[\\/]/i.test(path)) return null;
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) return null;
  return parts.filter(part => part && part !== ".").join("/") || null;
}

/** Match catalog paths, not one hard-coded folder. Do not extract or execute ZIP entries. */
export function collectReferencedAssetFiles(entries: Record<string, Uint8Array>, paths: string[], lessonPdfPaths: string[] = [], allowBareLessonPdfs = false): Map<string, Uint8Array> {
  const candidates: { path: string; bytes: Uint8Array }[] = [];
  for (const [entry, bytes] of Object.entries(entries)) {
    if (entry.endsWith("/") || entry.startsWith("__MACOSX/")) continue;
    const path = normalizedPath(entry);
    if (path) candidates.push({ path, bytes });
  }
  const result = new Map<string, Uint8Array>();
  for (const catalogPath of new Set(paths)) {
    const path = normalizedPath(catalogPath);
    if (!path) throw new Error(`Неприпустимий шлях файлу в каталозі: ${catalogPath}`);
    const exact = candidates.filter(candidate => candidate.path === path);
    // A full package ZIP can have an enclosing Geography/ directory.
    let matches = exact.length ? exact : candidates.filter(candidate => candidate.path.endsWith(`/${path}`));
    // Packages call their PDF folder both lessons/ and lesson_pdfs/. A
    // dedicated PDF ZIP may also contain the folder's contents at its root.
    // Use this fallback only for declared lesson PDFs with unique filenames.
    if (!matches.length && lessonPdfPaths.includes(catalogPath)) {
      const filename = path.split("/").at(-1)!;
      matches = candidates.filter(candidate => candidate.path.split("/").at(-1) === filename && (
        /(?:^|\/)(?:lessons|lesson_pdfs)\/[^/]+$/i.test(candidate.path) || (allowBareLessonPdfs && !candidate.path.includes("/"))
      ));
      if (matches.length && lessonPdfPaths.filter(pdfPath => normalizedPath(pdfPath)?.split("/").at(-1) === filename).length !== 1) {
        throw new Error(`Назва PDF ${filename} неоднозначна в каталозі. Збережіть структуру папок пакета.`);
      }
    }
    if (matches.length > 1) throw new Error(`У ZIP кілька файлів відповідають ${catalogPath}. Залиште один пакет в архіві.`);
    if (matches.length === 1) result.set(catalogPath, matches[0]!.bytes);
  }
  return result;
}
