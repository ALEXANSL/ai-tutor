import "server-only";
import { embedTexts } from "../ai/router";
import { createServiceClient } from "../supabase/clients";
import { buildTsQuery, cleanQuery } from "./query";

/**
 * Hybrid search over books (US-2.3, US-2.6 KP-2; ADR-008): vector + text,
 * fused in SQL. If embeddings are unavailable (no key, provider down,
 * budget), the search degrades to text-only instead of failing.
 */
export interface SearchHit {
  chunkId: string;
  materialId: string;
  materialName: string;
  materialTitle: string | null;
  materialKind: string;
  subjectId: string | null;
  topicId: string | null;
  topicTitle: string | null;
  sectionTitle: string | null;
  page: number | null;
  locator: string | null;
  snippet: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  mode: "hybrid" | "text_only";
}

export async function searchMaterials(
  familyId: string,
  rawQuery: string,
  filters: { subjectId?: string | null; kind?: string | null; materialId?: string | null; limit?: number } = {},
): Promise<SearchResult> {
  const query = cleanQuery(rawQuery);
  if (!query) return { hits: [], mode: "hybrid" };

  let embedding: number[] | null = null;
  try {
    const res = await embedTexts([query], { familyId });
    embedding = res.result[0] ?? null;
  } catch (e) {
    console.warn(`search: embeddings unavailable, text-only (${(e as Error).name})`);
  }

  const { data, error } = await createServiceClient().rpc("search_chunks", {
    p_family_id: familyId,
    p_query_text: query,
    p_tsquery: buildTsQuery(query),
    p_query_embedding: embedding ? JSON.stringify(embedding) : null,
    p_subject_id: filters.subjectId ?? null,
    p_kind: filters.kind ?? null,
    p_material_id: filters.materialId ?? null,
    p_limit: filters.limit ?? 10,
  });
  if (error) throw new Error(`search_chunks failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  return {
    mode: embedding ? "hybrid" : "text_only",
    hits: rows.map((r) => ({
      chunkId: String(r.chunk_id),
      materialId: String(r.material_id),
      materialName: String(r.material_name),
      materialTitle: (r.material_title as string | null) ?? null,
      materialKind: String(r.material_kind),
      subjectId: (r.subject_id as string | null) ?? null,
      topicId: (r.topic_id as string | null) ?? null,
      topicTitle: (r.topic_title as string | null) ?? null,
      sectionTitle: (r.section_title as string | null) ?? null,
      page: (r.page as number | null) ?? null,
      locator: (r.locator as string | null) ?? null,
      snippet: String(r.snippet ?? ""),
      score: Number(r.score ?? 0),
    })),
  };
}
