import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * PO feedback 2026-10-08: "де пошук по підручнику, зовсім обрізаний
 * функціонал у порівнянні з математикою" — literature-v2 was missing the
 * search box `mathCourseV2Search.ts` (S35) already has. Same approach:
 * search the already-imported lesson/task metadata, not the PDF itself.
 */

export interface LiteratureV2SearchLessonHit {
  id: string;
  title: string;
  printedPageFrom: number | null;
  printedPageTo: number | null;
}

export interface LiteratureV2SearchTaskHit {
  lessonId: string;
  lessonTitle: string;
  taskId: string;
  originalLabel: string;
  promptDisplay: string;
  printedPage: number | null;
}

export interface LiteratureV2SearchTextbook {
  materialId: string;
  title: string;
  pageCount: number | null;
}

export interface LiteratureV2SearchResult {
  lessonsByPage: LiteratureV2SearchLessonHit[];
  lessonsByTopic: LiteratureV2SearchLessonHit[];
  tasksByLabel: LiteratureV2SearchTaskHit[];
  textbook: LiteratureV2SearchTextbook | null;
}

interface LessonRow {
  id: string;
  title: string;
  printed_page_from: number | null;
  printed_page_to: number | null;
  package_id: string;
}

async function getTextbookForPackage(scope: ReturnType<typeof forFamily>, packageId: string): Promise<LiteratureV2SearchTextbook | null> {
  const { data: pkg } = await scope.select("literature_v2_packages", "textbook_material_id").eq("id", packageId).maybeSingle<{ textbook_material_id: string | null }>();
  if (!pkg?.textbook_material_id) return null;
  const { data: material } = await scope
    .select("materials", "title, name, page_count")
    .eq("id", pkg.textbook_material_id)
    .maybeSingle<{ title: string | null; name: string; page_count: number | null }>();
  if (!material) return null;
  return { materialId: pkg.textbook_material_id, title: material.title ?? material.name, pageCount: material.page_count };
}

/** Same role as `mathCourseV2Search.ts`'s `getMathCourseV2TextbookForSubject`. */
export async function getLiteratureV2TextbookForSubject(familyId: string, subjectId: string): Promise<LiteratureV2SearchTextbook | null> {
  const scope = forFamily(familyId);
  const { data: pkg } = await scope.select("literature_v2_packages", "id").eq("subject_id", subjectId).limit(1).maybeSingle<{ id: string }>();
  if (!pkg) return null;
  return getTextbookForPackage(scope, pkg.id);
}

export async function searchLiteratureV2(
  familyId: string,
  subjectId: string,
  query: { page?: number; taskLabel?: string; topicQuery?: string },
): Promise<LiteratureV2SearchResult> {
  const scope = forFamily(familyId);
  const { data: lessons } = await scope
    .select("literature_v2_lessons", "id, title, printed_page_from, printed_page_to, package_id")
    .eq("subject_id", subjectId)
    .eq("status", "active")
    .returns<LessonRow[]>();
  const lessonRows = lessons ?? [];

  let lessonsByPage: LiteratureV2SearchLessonHit[] = [];
  if (query.page != null && Number.isFinite(query.page)) {
    lessonsByPage = lessonRows
      .filter((l) => {
        if (l.printed_page_from == null) return false;
        const to = l.printed_page_to ?? l.printed_page_from;
        return query.page! >= l.printed_page_from && query.page! <= to;
      })
      .map((l) => ({ id: l.id, title: l.title, printedPageFrom: l.printed_page_from, printedPageTo: l.printed_page_to }));
  }

  let lessonsByTopic: LiteratureV2SearchLessonHit[] = [];
  const topicQuery = query.topicQuery?.trim().toLocaleLowerCase("uk");
  if (topicQuery) {
    lessonsByTopic = lessonRows
      .filter((l) => l.title.toLocaleLowerCase("uk").includes(topicQuery))
      .map((l) => ({ id: l.id, title: l.title, printedPageFrom: l.printed_page_from, printedPageTo: l.printed_page_to }));
  }

  let tasksByLabel: LiteratureV2SearchTaskHit[] = [];
  const label = query.taskLabel?.trim();
  if (label) {
    const lessonIds = lessonRows.map((l) => l.id);
    const lessonById = new Map(lessonRows.map((l) => [l.id, l]));
    if (lessonIds.length > 0) {
      const { data: tasks } = await scope
        .select("literature_v2_tasks", "id, lesson_id, original_label, prompt_display, printed_page")
        .in("lesson_id", lessonIds)
        .eq("original_label", label)
        .returns<{ id: string; lesson_id: string | null; original_label: string; prompt_display: string; printed_page: number | null }[]>();
      tasksByLabel = (tasks ?? [])
        .filter((t) => t.lesson_id != null && lessonById.has(t.lesson_id))
        .map((t) => ({
          lessonId: t.lesson_id!,
          lessonTitle: lessonById.get(t.lesson_id!)!.title,
          taskId: t.id,
          originalLabel: t.original_label,
          promptDisplay: t.prompt_display,
          printedPage: t.printed_page,
        }));
    }
  }

  const packageId = lessonRows[0]?.package_id;
  const textbook = packageId ? await getTextbookForPackage(scope, packageId) : null;

  return { lessonsByPage, lessonsByTopic, tasksByLabel, textbook };
}
