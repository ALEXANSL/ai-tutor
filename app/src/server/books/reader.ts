import "server-only";
import { forFamily } from "@/server/db/family-scope";
import type { SearchableChunk } from "./search";

/**
 * PDF book reader (Alex, 2026-10-02): the family-scoped lookups shared by
 * both the reader page (metadata only) and the two API routes (file proxy,
 * text search) — kept here so neither route re-implements the "does this
 * material belong to this family, and is it a PDF" check differently.
 */

export interface BookMaterialMeta {
  id: string;
  driveFileId: string;
  title: string | null;
  name: string;
  format: string;
  status: string;
  pageCount: number | null;
}

interface MaterialRow {
  id: string;
  drive_file_id: string;
  title: string | null;
  name: string;
  format: string;
  status: string;
  page_count: number | null;
}

/**
 * Only a PDF with a text layer makes sense here: EPUB has no fixed visual
 * page to render (chapters, not pages — ADR-031), and a book that is not
 * indexed at all (`queued`/`scan_no_text`/...) has no `chunks` to search,
 * though the original PDF can still be shown/paged through even then — the
 * caller decides what to do with `status`, this just fetches the row.
 */
export async function getBookMaterialMeta(familyId: string, materialId: string): Promise<BookMaterialMeta | null> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("materials", "id, drive_file_id, title, name, format, status, page_count")
    .eq("id", materialId)
    .is("removed_at", null)
    .maybeSingle<MaterialRow>();
  if (!data) return null;
  return {
    id: data.id,
    driveFileId: data.drive_file_id,
    title: data.title,
    name: data.name,
    format: data.format,
    status: data.status,
    pageCount: data.page_count,
  };
}

interface ChunkRow {
  page: number | null;
  locator: string | null;
  text: string;
}

/**
 * The already-extracted, already-stored text for this material (ADR-008),
 * ordered the same way indexing wrote it — reused for search instead of
 * asking pdf.js to re-extract every page's text on every query.
 */
export async function getBookSearchableText(familyId: string, materialId: string): Promise<SearchableChunk[]> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("chunks", "page, locator, text")
    .eq("material_id", materialId)
    .order("ordinal")
    .returns<ChunkRow[]>();
  return data ?? [];
}
