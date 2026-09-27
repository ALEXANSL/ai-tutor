import "server-only";
import { forFamily } from "../db/family-scope";
import { buildForecastPlan, type ForecastPlan } from "./plan";

/** Read models for "Предмети" (US-3.1, US-3.2) and, since E-22 (ADR-030), "Курси". */
export interface SubjectOverviewItem {
  id: string;
  code: string;
  name: string;
  active: boolean;
  hasTextbook: boolean;
  textbookTitle: string | null;
  currentTopic: { id: string; title: string; pageFrom: number | null; pageTo: number | null } | null;
  /** US-22.2/22.3: only set for kind='course' rows. */
  groupId: string | null;
  groupName: string | null;
}

export type SubjectKind = "school_subject" | "course";

interface SubjectRow {
  id: string;
  code: string;
  name_uk: string;
  active: boolean;
  kind?: SubjectKind;
  group_id?: string | null;
}

interface CourseGroupRow {
  id: string;
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

/**
 * "Предмети" (kind='school_subject', default — US-3.1, US-3.2) or "Курси"
 * (kind='course' — US-22.2 КП-1: an explicitly separate list, not the same
 * screen with a type switch). The parent sees every row of the requested
 * kind regardless of `active` — this is the management screen, not the
 * child's filtered view (that split is VP-52, applied only in
 * `app/(child)/today` and `getSubjectDetail`'s `childVisible` below).
 */
export async function listSubjectsOverview(familyId: string, kind: SubjectKind = "school_subject"): Promise<SubjectOverviewItem[]> {
  const scope = forFamily(familyId);
  const [{ data: subjects }, { data: textbooks }, { data: currentTopics }, { data: groups }] = await Promise.all([
    scope
      .select("subjects", "id, code, name_uk, active, sort_order, kind, group_id")
      .eq("is_stub", false)
      .eq("kind", kind)
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
    kind === "course"
      ? scope.select("course_groups", "id, name_uk, active").returns<CourseGroupRow[]>()
      : Promise.resolve({ data: [] as CourseGroupRow[] }),
  ]);
  const textbookBySubject = new Map<string, TextbookRow>();
  for (const b of textbooks ?? []) if (b.subject_id && !textbookBySubject.has(b.subject_id)) textbookBySubject.set(b.subject_id, b);
  const currentBySubject = new Map<string, TopicRow>();
  for (const t of currentTopics ?? []) currentBySubject.set(t.subject_id, t);
  const groupById = new Map((groups ?? []).map((g) => [g.id, g]));

  return (subjects ?? []).map((s) => {
    const book = textbookBySubject.get(s.id);
    const cur = currentBySubject.get(s.id);
    const group = s.group_id ? groupById.get(s.group_id) : undefined;
    return {
      id: s.id,
      code: s.code,
      name: s.name_uk,
      active: s.active,
      hasTextbook: !!book,
      textbookTitle: book ? (book.title ?? book.name) : null,
      currentTopic: cur ? { id: cur.id, title: cur.title, pageFrom: cur.page_from, pageTo: cur.page_to } : null,
      groupId: s.group_id ?? null,
      groupName: group?.name_uk ?? null,
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
  kind: SubjectKind;
  groupId: string | null;
  groupName: string | null;
  /**
   * VP-52 (ADR-030): the effective visibility rule the CHILD's own screens
   * must apply — `true` for every school subject once `active` (unchanged
   * grey-tile behaviour lives in the render, not here), and for a course
   * only when both the course AND (if it belongs to one) its group are
   * active (US-22.3 КП-3: `group.active AND course.active`). A direct link
   * to a course whose group got turned off must 404 just like an inactive
   * course does — see `effectiveCourseVisible` below, the single shared
   * expression for both kinds.
   */
  childVisible: boolean;
}

/**
 * Shared effective-visibility expression (VP-52, US-22.3 КП-3): a course is
 * visible to the child only when it is itself active AND (if it belongs to
 * a group) that group is active too. A school subject has no group, so this
 * is trivially `active` for it — the caller still separately decides
 * "grey tile" vs "hidden" by `kind`, this only answers "can she reach it at
 * all", which is what a direct `/subject/[id]` link must enforce.
 */
export function effectiveCourseVisible(active: boolean, groupActive: boolean | null): boolean {
  return active && (groupActive === null || groupActive);
}

export async function getSubjectDetail(familyId: string, subjectId: string): Promise<SubjectDetail | null> {
  const scope = forFamily(familyId);
  const { data: subject } = await scope
    .select("subjects", "id, code, name_uk, active, kind, group_id")
    .eq("id", subjectId)
    .eq("is_stub", false)
    .maybeSingle<SubjectRow>();
  if (!subject) return null;

  const [{ data: textbook }, { data: topics }, { data: group }] = await Promise.all([
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
    subject.group_id
      ? scope.select("course_groups", "name_uk, active").eq("id", subject.group_id).maybeSingle<{ name_uk: string; active: boolean }>()
      : Promise.resolve({ data: null as { name_uk: string; active: boolean } | null }),
  ]);

  const topicList = topics ?? [];
  const kind = subject.kind ?? "school_subject";
  return {
    id: subject.id,
    code: subject.code,
    name: subject.name_uk,
    active: subject.active,
    hasTextbook: !!textbook,
    textbookTitle: textbook ? (textbook.title ?? textbook.name) : null,
    topics: topicList.map((t) => ({ id: t.id, title: t.title, pageFrom: t.page_from, pageTo: t.page_to })),
    currentTopicId: topicList.find((t) => t.is_current)?.id ?? null,
    kind,
    groupId: subject.group_id ?? null,
    groupName: group?.name_uk ?? null,
    childVisible: kind === "school_subject" ? subject.active : effectiveCourseVisible(subject.active, subject.group_id ? (group?.active ?? false) : null),
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

/** US-22.4 (D-108, S33): subject + topic metadata `ensureActiveLibraryBlock` needs. */
export interface WarmupTopicMeta {
  id: string;
  title: string;
  grade: number | null;
}
export interface WarmupSubjectMeta {
  id: string;
  nameUk: string;
  config: Record<string, unknown>;
  topics: WarmupTopicMeta[];
}

/**
 * US-22.4 (D-108): loads exactly what the bulk-warmup confirm action needs to
 * call `ensureActiveLibraryBlock` for each requested topic — never trusts
 * anything the client sent beyond the topic ids themselves.
 */
export async function getSubjectForBulkWarmup(familyId: string, subjectId: string, topicIds: string[]): Promise<WarmupSubjectMeta | null> {
  const scope = forFamily(familyId);
  const { data: subject } = await scope
    .select("subjects", "id, name_uk, config")
    .eq("id", subjectId)
    .maybeSingle<{ id: string; name_uk: string; config: Record<string, unknown> | null }>();
  if (!subject) return null;

  const uniqueIds = Array.from(new Set(topicIds));
  const { data: topics } = uniqueIds.length
    ? await scope
        .select("topics", "id, title, grade")
        .eq("subject_id", subjectId)
        .in("id", uniqueIds)
        .returns<WarmupTopicMeta[]>()
    : { data: [] as WarmupTopicMeta[] };

  return { id: subject.id, nameUk: subject.name_uk, config: subject.config ?? {}, topics: topics ?? [] };
}

/** "Курси → Групи" (US-22.3): a group and how many courses it currently holds. */
export interface CourseGroupOverviewItem {
  id: string;
  name: string;
  active: boolean;
  courseCount: number;
}

export async function listCourseGroupsOverview(familyId: string): Promise<CourseGroupOverviewItem[]> {
  const scope = forFamily(familyId);
  const [{ data: groups }, { data: courses }] = await Promise.all([
    scope.select("course_groups", "id, name_uk, active, sort_order").order("sort_order").returns<(CourseGroupRow & { sort_order: number })[]>(),
    scope.select("subjects", "group_id").eq("kind", "course").eq("is_stub", false).not("group_id", "is", null).returns<{ group_id: string | null }[]>(),
  ]);
  const countByGroup = new Map<string, number>();
  for (const c of courses ?? []) if (c.group_id) countByGroup.set(c.group_id, (countByGroup.get(c.group_id) ?? 0) + 1);
  return (groups ?? []).map((g) => ({ id: g.id, name: g.name_uk, active: g.active, courseCount: countByGroup.get(g.id) ?? 0 }));
}
