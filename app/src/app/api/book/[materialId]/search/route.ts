import { NextResponse, type NextRequest } from "next/server";
import { requireChild } from "@/server/auth/guards";
import { getBookMaterialMeta, getBookSearchableText } from "@/server/books/reader";
import { parseNumberQuery, searchMaterialText } from "@/server/books/search";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_LEN = 200;

export const dynamic = "force-dynamic";

/**
 * PDF reader free-text / numbering search (Alex, 2026-10-02) — $0, no AI
 * call: searches the text the ingest pipeline already extracted into
 * `chunks` (ADR-008/031), never re-parses the PDF. See `server/books/search.ts`
 * for the matching logic (unit-tested there).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  if (!UUID.test(materialId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { ctx } = await requireChild();

  const q = (request.nextUrl.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LEN);
  if (!q.trim()) return NextResponse.json({ hits: [], matchedAs: null });

  const meta = await getBookMaterialMeta(ctx.familyId, materialId);
  if (!meta || meta.format !== "pdf") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const chunks = await getBookSearchableText(ctx.familyId, materialId);
  const hits = searchMaterialText(chunks, q);
  const numberQuery = parseNumberQuery(q);
  return NextResponse.json({
    hits: hits.slice(0, 50),
    matchedAs: numberQuery ? { label: numberQuery.label, number: numberQuery.number } : null,
  });
}
