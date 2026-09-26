import "server-only";
import { forFamily } from "../db/family-scope";
import { buildForecastPlan, type ForecastPlan } from "./plan";

/** Read models for "Предмети" (US-3.1, US-3.2). */
export interface SubjectOverviewItem {
  id: string;
  code: string;
  name: string;
  active: boolean;
  hasTextbook: boolean;
  textbookTitle: string | null;
  currentTopic: { id: string; title: string; pageFrom: number | null; pageTo: number | null } | null;
}

interface SubjectRow {
  id: string;
  code: string;
  name_uk: string;
  active: boolean;
}
interface TextbookRow {
  subject_id: string | null;
  title: string | null;
  name: string;
}
interface TopicRow {
  id: string;
  subject_id: string;
  title: string;
  page_from: number | null;
  page_to: number | null;
  is_current: boolean;
}

/** Only a `textbook`-kind, indexed and enabled book counts as "has a textbook" (US-3.1 KP-2). */
const READY_TEXTBOOK_FILTERS = { kind: "textbook", status: "ready", use_in_lessons: true } as const;

export async function listSubjectsOverview(familyId: string): Promise<SubjectOverviewItem[]> {
  const scope = forFamily(familyId);
  const [{ data: subjects }, { data: textbooks }, { data: currentTopics }] = await Promise.all([
    scope
      .select("subjects", "id, code, name_uk, active, sort_order")
      .eq("is_stub", false)
      .order("sort_order")
      .returns<(SubjectRow & { sort_order: number })[]>(),
    scope
      .select("materials", "subject_id, title, name")
      .eq("kind", READY_TEXTBOOK_FILTERS.kind)
      .eq("status", READY_TEXTBOOK_FILTERS.status)
      .eq("use_in_lessons", READY_TEXTBOOK_FILTERS.use_in_lessons)
      .not("subject_id", "is", null)
      .returns<TextbookRow[]>(),
    scope
      .select("topics", "id, subject_id, title, page_from, page_to, is_current")
      .eq("is_current", true)
      .returns<TopicRow[]>(),
  ]);
  const textbookBySubject = new Map<string, TextbookRow>();
  for (const b of textbooks ?? []) if (b.subject_id && !textbookBySubject.has(b.subject_id)) textbookBySubject.set(b.subject_id, b);
  const currentBySubject = new Map<string, TopicRow>();
  for (const t of currentTopics ?? []) currentBySubject.set(t.subject_id, t);

  return (subjects ?? []).map((s) => {
    const book = textbookBySubject.get(s.id);
    const cur = currentBySubject.get(s.id);
    return {
      id: s.id,
      code: s.code,
      name: s.name_uk,
      active: s.active,
      hasTextbook: !!book,
      textbookTitle: book ? (book.title ?? book.name) : null,
      currentTopic: cur ? { id: cur.id, title: cur.title, pageFrom: cur.page_from, pageTo: cur.page_to } : null,
    };
  });
}

export interface SubjectTopicOption {
  id: string;
  title: string;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface SubjectDetail {
  id: string;
  code: string;
  name: string;
  active: boolean;
  hasTextbook: boolean;
  textbookTitle: string | null;
  topics: SubjectTopicOption[];
  currentTopicId: string | null;
}

export async function getSubjectDetail(familyId: string, subjectId: string): Promise<SubjectDetail | null> {
  const scope = forFamily(familyId);
  const { data: subject } = await scope
    .select("subjects", "id, code, name_uk, active")
    .eq("id", subjectId)
    .eq("is_stub", false)
    .maybeSingle<SubjectRow>();
  if (!subject) return null;

  const [{ data: textbook }, { data: topics }] = await Promise.all([
    scope
      .select("materials", "title, name")
      .eq("subject_id", subjectId)
      .eq("kind", READY_TEXTBOOK_FILTERS.kind)
      .eq("status", READY_TEXTBOOK_FILTERS.status)
      .eq("use_in_lessons", READY_TEXTBOOK_FILTERS.use_in_lessons)
      .order("added_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ title: string | null; name: string }>(),
    scope
      .select("topics", "id, title, page_from, page_to, sort_order, is_current")
      .eq("subject_id", subjectId)
      .order("sort_order")
      .returns<{ id: string; title: string; page_from: number | null; page_to: number | null; sort_order: number; is_current: boolean }[]>(),
  ]);

  const topicList = topics ?? [];
  return {
    id: subject.id,
    code: subject.code,
    name: subject.name_uk,
    active: subject.active,
    hasTextbook: !!textbook,
    textbookTitle: textbook ? (textbook.title ?? textbook.name) : null,
    topics: topicList.map((t) => ({ id: t.id, title: t.title, pageFrom: t.page_from, pageTo: t.page_to })),
    currentTopicId: topicList.find((t) => t.is_current)?.id ?? null,
  };
}

/**
 * Forecast-plan for the subject's current topic (US-3.2 KP-1). Topics keep
 * the subject's curriculum order (`sort_order`); dependencies come from the
 * structure the AI proposed during indexing (S1) plus any parent fixes.
 */
export async function getSubjectForecastPlan(familyId: string, subjectId: string): Promise<ForecastPlan | null> {
  const scope = forFamily(familyId);
  const { data: topics } = await scope
    .select("topics", "id, title, page_from, page_to, sort_order, is_current")
    .eq("subject_id", subjectId)
    .order("sort_order")
    .returns<{ id: string; title: string; page_from: number | null; page_to: number | null; sort_order: number; is_current: boolean }[]>();
  const topicList = topics ?? [];
  const current = topicList.find((t) => t.is_current);
  if (!current) return null;

  const topicIds = topicList.map((t) => t.id);
  const { data: deps } = topicIds.length
    ? await scope.select("topic_dependencies", "topic_id, depends_on_id").in("topic_id", topicIds).returns<{ topic_id: string; depends_on_id: string }[]>()
    : { data: [] as { topic_id: string; depends_on_id: string }[] };

  const nodes = topicList.map((t) => ({ id: t.id, title: t.title, pageFrom: t.page_from, pageTo: t.page_to, sortOrder: t.sort_order }));
  const edges = (deps ?? []).map((d) => ({ topicId: d.topic_id, dependsOnId: d.depends_on_id }));
  return buildForecastPlan(current.id, nodes, edges);
}
