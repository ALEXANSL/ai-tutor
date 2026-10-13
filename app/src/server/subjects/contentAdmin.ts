import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * Read models for S42 (E-29, US-29.1/29.2/29.3) — the parent cabinet's
 * "Адмін-операції без SQL" screen. Every function here is a plain read
 * (parent already has full SELECT on all of these tables, see each
 * migration's `*_select_parent` policy) — only the actual writes
 * (archive/toggle/delete/link-textbook) go through the SECURITY DEFINER
 * RPCs in `20261022100000_s42_admin_content_ops.sql`, called from
 * `app/actions/content-admin.ts`.
 */

export type LessonSystem = "literature" | "course" | "course_v2" | "literature_v2";

const LESSON_TABLE: Record<LessonSystem, string> = {
  literature: "literature_lessons",
  course: "course_lessons",
  course_v2: "course_v2_lessons",
  literature_v2: "literature_v2_lessons",
};

export interface SubjectCleanupPreview {
  /** Sum of not-yet-archived lesson rows across all four import systems. */
  lessonsCount: number;
  /** Not-yet-archived topics of the subject (includes old-pipeline orphans). */
  topicsCount: number;
  /** Best-effort sum of exercises/tests/questions tied to those lessons. */
  tasksCount: number;
  /** US-29.1 КП-2: whether confirming would also archive recorded child progress. */
  hasChildProgress: boolean;
}

async function countNotArchived(scope: ReturnType<typeof forFamily>, table: string, subjectId: string): Promise<number> {
  const { count } = await scope.count(table).eq("subject_id", subjectId).neq("status", "archived");
  return count ?? 0;
}

async function idsOf(scope: ReturnType<typeof forFamily>, table: string, subjectId: string): Promise<string[]> {
  const { data } = await scope.select(table, "id").eq("subject_id", subjectId).neq("status", "archived").returns<{ id: string }[]>();
  return (data ?? []).map((r) => r.id);
}

async function countWhereIn(scope: ReturnType<typeof forFamily>, table: string, column: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { count } = await scope.client.from(table).select("*", { count: "exact", head: true }).in(column, ids);
  return count ?? 0;
}

/** US-29.1 КП-1: the exact preview shown before the first confirmation click. */
export async function getSubjectCleanupPreview(familyId: string, subjectId: string): Promise<SubjectCleanupPreview> {
  const scope = forFamily(familyId);

  const [literatureLessonIds, courseLessonIds, courseV2LessonIds, literatureV2LessonIds] = await Promise.all([
    idsOf(scope, "literature_lessons", subjectId),
    idsOf(scope, "course_lessons", subjectId),
    idsOf(scope, "course_v2_lessons", subjectId),
    idsOf(scope, "literature_v2_lessons", subjectId),
  ]);
  const lessonsCount = literatureLessonIds.length + courseLessonIds.length + courseV2LessonIds.length + literatureV2LessonIds.length;

  const topicsCount = await countNotArchived(scope, "topics", subjectId);

  const [{ data: coursePackages }, { data: courseV2Packages }, { data: literatureV2Packages }] = await Promise.all([
    scope.select("course_packages", "id").eq("subject_id", subjectId).returns<{ id: string }[]>(),
    scope.select("course_v2_packages", "id").eq("subject_id", subjectId).returns<{ id: string }[]>(),
    scope.select("literature_v2_packages", "id").eq("subject_id", subjectId).returns<{ id: string }[]>(),
  ]);
  const coursePackageIds = (coursePackages ?? []).map((p) => p.id);
  const courseV2PackageIds = (courseV2Packages ?? []).map((p) => p.id);
  const literatureV2PackageIds = (literatureV2Packages ?? []).map((p) => p.id);

  const [literatureTests, courseTests, courseExercises, courseV2Questions, courseV2Exercises, literatureV2Tasks] = await Promise.all([
    countWhereIn(scope, "literature_lesson_tests", "lesson_id", literatureLessonIds),
    countWhereIn(scope, "course_lesson_tests", "lesson_id", courseLessonIds),
    countWhereIn(scope, "course_exercises", "package_id", coursePackageIds),
    countWhereIn(scope, "course_v2_questions", "lesson_id", courseV2LessonIds),
    countWhereIn(scope, "course_v2_exercises", "package_id", courseV2PackageIds),
    countWhereIn(scope, "literature_v2_tasks", "package_id", literatureV2PackageIds),
  ]);
  const tasksCount = literatureTests + courseTests + courseExercises + courseV2Questions + courseV2Exercises + literatureV2Tasks;

  // US-29.1 КП-2: any recorded attempt for this subject's content — the old
  // pipeline's `step_attempts` (via lesson_sessions.topic_id, step_attempts
  // itself has no topic_id) or S35's `course_v2_question_attempts` (via
  // question_id -> lesson_id).
  const { data: topicIds } = await scope.select("topics", "id").eq("subject_id", subjectId).returns<{ id: string }[]>();
  const [stepAttempts, questionAttempts] = await Promise.all([
    (async () => {
      const ids = (topicIds ?? []).map((t) => t.id);
      if (ids.length === 0) return 0;
      const { data: sessions } = await scope.select("lesson_sessions", "id").in("topic_id", ids).returns<{ id: string }[]>();
      return countWhereIn(scope, "step_attempts", "session_id", (sessions ?? []).map((s) => s.id));
    })(),
    (async () => {
      if (courseV2LessonIds.length === 0) return 0;
      const { data: questionIds } = await scope.select("course_v2_questions", "id").in("lesson_id", courseV2LessonIds).returns<{ id: string }[]>();
      return countWhereIn(scope, "course_v2_question_attempts", "question_id", (questionIds ?? []).map((q) => q.id));
    })(),
  ]);

  return { lessonsCount, topicsCount, tasksCount, hasChildProgress: stepAttempts > 0 || questionAttempts > 0 };
}

export interface SubjectLessonRow {
  system: LessonSystem;
  id: string;
  title: string;
  status: string;
  printedPageFrom: number | null;
  printedPageTo: number | null;
  /** US-29.3 КП-2: whether a delete is blocked because recorded progress exists. */
  hasProgress: boolean;
}

/** US-29.3: every lesson of the subject, across all four systems, status included (never filtered to `active` — this IS the management screen). */
export async function listSubjectLessons(familyId: string, subjectId: string): Promise<SubjectLessonRow[]> {
  const scope = forFamily(familyId);

  const [{ data: literatureRows }, { data: courseRows }, { data: courseV2Rows }, { data: literatureV2Rows }] = await Promise.all([
    scope
      .select("literature_lessons", "id, title, status, textbook_page_from, textbook_page_to")
      .eq("subject_id", subjectId)
      .order("sort_order")
      .returns<{ id: string; title: string; status: string; textbook_page_from: number | null; textbook_page_to: number | null }[]>(),
    scope
      .select("course_lessons", "id, title, status, source")
      .eq("subject_id", subjectId)
      .order("sort_order")
      .returns<{ id: string; title: string; status: string; source: { printed_pages?: number[] } | null }[]>(),
    scope
      .select("course_v2_lessons", "id, title, status, printed_page_from, printed_page_to")
      .eq("subject_id", subjectId)
      .order("order_no")
      .returns<{ id: string; title: string; status: string; printed_page_from: number | null; printed_page_to: number | null }[]>(),
    scope
      .select("literature_v2_lessons", "id, title, status, printed_page_from, printed_page_to")
      .eq("subject_id", subjectId)
      .order("order_no")
      .returns<{ id: string; title: string; status: string; printed_page_from: number | null; printed_page_to: number | null }[]>(),
  ]);

  const courseV2LessonIds = (courseV2Rows ?? []).map((l) => l.id);
  const { data: progressQuestions } =
    courseV2LessonIds.length > 0
      ? await scope.select("course_v2_questions", "id, lesson_id").in("lesson_id", courseV2LessonIds).returns<{ id: string; lesson_id: string }[]>()
      : { data: [] as { id: string; lesson_id: string }[] };
  const questionIds = (progressQuestions ?? []).map((q) => q.id);
  const { data: attempts } =
    questionIds.length > 0
      ? await scope.select("course_v2_question_attempts", "question_id").in("question_id", questionIds).returns<{ question_id: string }[]>()
      : { data: [] as { question_id: string }[] };
  const lessonIdsWithProgress = new Set(
    (attempts ?? []).map((a) => progressQuestions?.find((q) => q.id === a.question_id)?.lesson_id).filter((id): id is string => !!id),
  );

  const rows: SubjectLessonRow[] = [];
  for (const l of literatureRows ?? [])
    rows.push({ system: "literature", id: l.id, title: l.title, status: l.status, printedPageFrom: l.textbook_page_from, printedPageTo: l.textbook_page_to, hasProgress: false });
  for (const l of courseRows ?? []) {
    const pages = l.source?.printed_pages ?? [];
    rows.push({
      system: "course",
      id: l.id,
      title: l.title,
      status: l.status,
      printedPageFrom: pages.length > 0 ? Math.min(...pages) : null,
      printedPageTo: pages.length > 0 ? Math.max(...pages) : null,
      hasProgress: false,
    });
  }
  for (const l of courseV2Rows ?? [])
    rows.push({
      system: "course_v2",
      id: l.id,
      title: l.title,
      status: l.status,
      printedPageFrom: l.printed_page_from,
      printedPageTo: l.printed_page_to,
      hasProgress: lessonIdsWithProgress.has(l.id),
    });
  for (const l of literatureV2Rows ?? [])
    rows.push({ system: "literature_v2", id: l.id, title: l.title, status: l.status, printedPageFrom: l.printed_page_from, printedPageTo: l.printed_page_to, hasProgress: false });
  return rows;
}

export type PackageKind = "course_v2" | "literature_v2";

export interface SubjectPackageRow {
  kind: PackageKind;
  id: string;
  title: string;
  textbookMaterialId: string | null;
  /** Largest `printed_page_to` of the package's own lessons — US-29.2 КП-3's coverage check. */
  maxPrintedPageTo: number | null;
}

/** US-29.2: the course_v2/literature_v2 packages of this subject — the only two systems with a `textbook_material_id` column (S35/S36c). */
export async function listSubjectPackages(familyId: string, subjectId: string): Promise<SubjectPackageRow[]> {
  const scope = forFamily(familyId);
  const [{ data: courseV2 }, { data: literatureV2 }] = await Promise.all([
    scope.select("course_v2_packages", "id, title, textbook_material_id").eq("subject_id", subjectId).returns<{ id: string; title: string; textbook_material_id: string | null }[]>(),
    scope
      .select("literature_v2_packages", "id, title, textbook_material_id")
      .eq("subject_id", subjectId)
      .returns<{ id: string; title: string; textbook_material_id: string | null }[]>(),
  ]);

  const rows: SubjectPackageRow[] = [];
  for (const p of courseV2 ?? []) {
    const { data: lessons } = await scope.select("course_v2_lessons", "printed_page_to").eq("package_id", p.id).returns<{ printed_page_to: number | null }[]>();
    const maxPage = (lessons ?? []).reduce<number | null>((m, l) => (l.printed_page_to != null && (m == null || l.printed_page_to > m) ? l.printed_page_to : m), null);
    rows.push({ kind: "course_v2", id: p.id, title: p.title, textbookMaterialId: p.textbook_material_id, maxPrintedPageTo: maxPage });
  }
  for (const p of literatureV2 ?? []) {
    const { data: lessons } = await scope.select("literature_v2_lessons", "printed_page_to").eq("package_id", p.id).returns<{ printed_page_to: number | null }[]>();
    const maxPage = (lessons ?? []).reduce<number | null>((m, l) => (l.printed_page_to != null && (m == null || l.printed_page_to > m) ? l.printed_page_to : m), null);
    rows.push({ kind: "literature_v2", id: p.id, title: p.title, textbookMaterialId: p.textbook_material_id, maxPrintedPageTo: maxPage });
  }
  return rows;
}

export interface SubjectPdfOption {
  id: string;
  title: string;
  pageCount: number | null;
}

/**
 * US-29.2 КП-1 / S43 (textbook linking directly from the import screen,
 * PO request 2026-10-13): already-uploaded, already-indexed PDFs of this
 * subject — the dropdown's options, on both the subject's content-admin
 * screen and the import panels (`listSubjectPdfMaterialsAction`,
 * `app/actions/content-admin.ts`).
 */
export async function listSubjectPdfMaterials(familyId: string, subjectId: string): Promise<SubjectPdfOption[]> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("materials", "id, title, name, page_count")
    .eq("subject_id", subjectId)
    .eq("format", "pdf")
    .order("added_at", { ascending: false })
    .returns<{ id: string; title: string | null; name: string; page_count: number | null }[]>();
  return (data ?? []).map((m) => ({ id: m.id, title: m.title ?? m.name, pageCount: m.page_count }));
}

export function lessonTableOf(system: LessonSystem): string {
  return LESSON_TABLE[system];
}
