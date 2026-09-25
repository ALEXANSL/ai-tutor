import "server-only";
import { forFamily } from "../db/family-scope";

/** Read models for "Мої книги" (US-2.7 KP-1) and the book page (US-2.2 KP-1, 2). */
export interface BookListItem {
  id: string;
  name: string;
  title: string | null;
  format: "pdf" | "epub";
  kind: string;
  subjectId: string | null;
  useInLessons: boolean;
  status: string;
  statusDetail: string | null;
  progress: { step?: string; done?: number; total?: number };
  pageCount: number | null;
  addedAt: string;
  costUsd: number;
}

export interface SubjectOption {
  id: string;
  code: string;
  name: string;
}

interface MaterialDbRow {
  id: string;
  name: string;
  title: string | null;
  format: "pdf" | "epub";
  kind: string;
  subject_id: string | null;
  use_in_lessons: boolean;
  status: string;
  status_detail: string | null;
  progress: BookListItem["progress"] | null;
  page_count: number | null;
  added_at: string;
}

async function costsFor(familyId: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { data } = await forFamily(familyId)
    .select("ai_calls", "ref_id, cost_usd")
    .eq("ref_table", "materials")
    .in("ref_id", ids)
    .returns<{ ref_id: string; cost_usd: string | number }[]>();
  for (const r of data ?? []) out.set(r.ref_id, (out.get(r.ref_id) ?? 0) + Number(r.cost_usd));
  return out;
}

const toItem = (r: MaterialDbRow, cost: number): BookListItem => ({
  id: r.id,
  name: r.name,
  title: r.title,
  format: r.format,
  kind: r.kind,
  subjectId: r.subject_id,
  useInLessons: r.use_in_lessons,
  status: r.status,
  statusDetail: r.status_detail,
  progress: r.progress ?? {},
  pageCount: r.page_count,
  addedAt: r.added_at,
  costUsd: cost,
});

const MATERIAL_COLUMNS =
  "id, name, title, format, kind, subject_id, use_in_lessons, status, status_detail, progress, page_count, added_at";

/** Books from the folder, newest first; books removed from the folder are not listed (US-2.6 KP-6). */
export async function listBooks(familyId: string): Promise<BookListItem[]> {
  const { data, error } = await forFamily(familyId)
    .select("materials", MATERIAL_COLUMNS)
    .neq("status", "removed")
    .order("added_at", { ascending: false })
    .returns<MaterialDbRow[]>();
  if (error) throw new Error(`listBooks failed: ${error.message}`);
  const rows = data ?? [];
  const costs = await costsFor(familyId, rows.map((r) => r.id));
  return rows.map((r) => toItem(r, costs.get(r.id) ?? 0));
}

export async function listSubjects(familyId: string): Promise<SubjectOption[]> {
  const { data } = await forFamily(familyId)
    .select("subjects", "id, code, name_uk, is_stub, sort_order")
    .eq("is_stub", false)
    .order("sort_order")
    .returns<{ id: string; code: string; name_uk: string }[]>();
  return (data ?? []).map((s) => ({ id: s.id, code: s.code, name: s.name_uk }));
}

export interface BookDetail extends BookListItem {
  provenance: string | null;
  grade: number | null;
  indexedAt: string | null;
  kindManual: boolean;
  subjectManual: boolean;
  topicsManual: boolean;
  sections: {
    id: string;
    title: string;
    pageFrom: number | null;
    pageTo: number | null;
    topics: { id: string; title: string; pageFrom: number | null; pageTo: number | null; manual: boolean }[];
  }[];
  linkedTopicIds: string[];
}

export async function getBook(familyId: string, id: string): Promise<BookDetail | null> {
  const scope = forFamily(familyId);
  const { data: m } = await scope
    .select("materials", `${MATERIAL_COLUMNS}, provenance, grade, indexed_at, kind_manual, subject_manual, topics_manual`)
    .eq("id", id)
    .maybeSingle<
      MaterialDbRow & {
        provenance: string | null;
        grade: number | null;
        indexed_at: string | null;
        kind_manual: boolean;
        subject_manual: boolean;
        topics_manual: boolean;
      }
    >();
  if (!m) return null;
  const [{ data: sections }, { data: topics }, { data: links }, costs] = await Promise.all([
    scope
      .select("material_sections", "id, title, page_from, page_to, sort_order")
      .eq("material_id", id)
      .order("sort_order")
      .returns<{ id: string; title: string; page_from: number | null; page_to: number | null }[]>(),
    scope
      .select("topics", "id, title, page_from, page_to, section_id, sort_order, manual_override")
      .eq("material_id", id)
      .order("sort_order")
      .returns<
        { id: string; title: string; page_from: number | null; page_to: number | null; section_id: string | null; manual_override: boolean }[]
      >(),
    scope.select("material_topic_links", "topic_id").eq("material_id", id).returns<{ topic_id: string }[]>(),
    costsFor(familyId, [id]),
  ]);
  const topicList = topics ?? [];
  const mapTopic = (t: (typeof topicList)[number]) => ({
    id: t.id,
    title: t.title,
    pageFrom: t.page_from,
    pageTo: t.page_to,
    manual: t.manual_override,
  });
  const sectionList = (sections ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    pageFrom: s.page_from,
    pageTo: s.page_to,
    topics: topicList.filter((t) => t.section_id === s.id).map(mapTopic),
  }));
  const orphans = topicList.filter((t) => !t.section_id || !sectionList.some((s) => s.id === t.section_id));
  if (orphans.length) sectionList.push({ id: "none", title: "—", pageFrom: null, pageTo: null, topics: orphans.map(mapTopic) });
  return {
    ...toItem(m, costs.get(id) ?? 0),
    provenance: m.provenance,
    grade: m.grade,
    indexedAt: m.indexed_at,
    kindManual: m.kind_manual,
    subjectManual: m.subject_manual,
    topicsManual: m.topics_manual,
    sections: sectionList,
    linkedTopicIds: (links ?? []).map((l) => l.topic_id),
  };
}

/** Topics of textbooks (for linking other books to topics, US-2.6 KP-1). */
export async function listTextbookTopics(familyId: string): Promise<{ id: string; title: string; subjectId: string }[]> {
  const { data } = await forFamily(familyId)
    .select("topics", "id, title, subject_id, sort_order")
    .order("sort_order")
    .limit(1000)
    .returns<{ id: string; title: string; subject_id: string }[]>();
  return (data ?? []).map((t) => ({ id: t.id, title: t.title, subjectId: t.subject_id }));
}
