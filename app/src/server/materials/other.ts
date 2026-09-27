import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * "Інше" (US-23.1, E-23, D-105): nonschool materials the child can open
 * without any parent action beyond indexing itself — computed on the fly
 * (ВП-54), no new table, no new RPC.
 *
 * Visibility criterion (КП-1, КП-2, КП-6 — all four together):
 *  - `kind <> 'textbook'` (a textbook always belongs to a subject/topic flow);
 *  - `status = 'ready'` (indexed);
 *  - `use_in_lessons = true` (the existing "Мої книги" toggle, no new UI);
 *  - `subject_id is null` (not attached to a course, US-22.2 КП-3 / S31);
 *  - no `material_topic_links` row (not manually linked to a topic, US-2.6 КП-1).
 * A material leaving any of these (linked later, subject attached, toggled
 * off) disappears from this list and its detail (`getOtherMaterialDetail`
 * below) the same way — КП-2/КП-6, no separate "unpublish" step needed.
 */
export interface OtherMaterialItem {
  id: string;
  name: string;
  title: string | null;
  kind: string;
}

interface MaterialCandidateRow {
  id: string;
  name: string;
  title: string | null;
  kind: string;
  added_at: string;
}

export async function listUnlinkedMaterials(familyId: string): Promise<OtherMaterialItem[]> {
  const scope = forFamily(familyId);
  const { data: materials } = await scope
    .select("materials", "id, name, title, kind, added_at")
    .neq("kind", "textbook")
    .eq("status", "ready")
    .eq("use_in_lessons", true)
    .is("subject_id", null)
    .order("added_at", { ascending: false })
    .returns<MaterialCandidateRow[]>();
  const rows = materials ?? [];
  if (rows.length === 0) return [];

  const { data: links } = await scope
    .select("material_topic_links", "material_id")
    .in(
      "material_id",
      rows.map((r) => r.id),
    )
    .returns<{ material_id: string }[]>();
  const linked = new Set((links ?? []).map((l) => l.material_id));

  return rows.filter((r) => !linked.has(r.id)).map((r) => ({ id: r.id, name: r.name, title: r.title, kind: r.kind }));
}

export interface OtherMaterialChunkView {
  id: string;
  sectionTitle: string | null;
  page: number | null;
  text: string;
}

export interface OtherMaterialDetail {
  id: string;
  name: string;
  title: string | null;
  kind: string;
  chunks: OtherMaterialChunkView[];
}

/**
 * КП-3: the already-indexed text, in the SAME order indexing stored it
 * (`chunks.ordinal`) — no AI call, `$0`. Returns `null` for anything that no
 * longer meets the "Інше" visibility criterion above (removed, linked to a
 * topic since, toggled off, or a direct guess at another family's id) — the
 * caller 404s, same convention as the child's `/subject/[id]` page.
 */
export async function getOtherMaterialDetail(familyId: string, materialId: string): Promise<OtherMaterialDetail | null> {
  const scope = forFamily(familyId);
  const { data: material } = await scope
    .select("materials", "id, name, title, kind, status, use_in_lessons, subject_id")
    .eq("id", materialId)
    .maybeSingle<{
      id: string;
      name: string;
      title: string | null;
      kind: string;
      status: string;
      use_in_lessons: boolean;
      subject_id: string | null;
    }>();
  if (!material || material.kind === "textbook" || material.status !== "ready" || !material.use_in_lessons || material.subject_id) return null;

  const { data: link } = await scope.select("material_topic_links", "material_id").eq("material_id", materialId).limit(1).maybeSingle<{ material_id: string }>();
  if (link) return null;

  const [{ data: chunks }, { data: sections }] = await Promise.all([
    scope
      .select("chunks", "id, section_id, page, text")
      .eq("material_id", materialId)
      .order("ordinal")
      .returns<{ id: string; section_id: string | null; page: number | null; text: string }[]>(),
    scope.select("material_sections", "id, title").eq("material_id", materialId).returns<{ id: string; title: string }[]>(),
  ]);
  const sectionTitleById = new Map((sections ?? []).map((s) => [s.id, s.title]));

  return {
    id: material.id,
    name: material.name,
    title: material.title,
    kind: material.kind,
    chunks: (chunks ?? []).map((c) => ({
      id: c.id,
      sectionTitle: c.section_id ? (sectionTitleById.get(c.section_id) ?? null) : null,
      page: c.page,
      text: c.text,
    })),
  };
}
