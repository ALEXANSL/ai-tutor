import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S35 follow-up (PO request 2026-10-07): "пошук уроків за сторінкою в книзі
 * або за номером задачі" — searches the already-imported structured
 * lesson/exercise metadata: given a textbook page number, which lesson(s)
 * cover it; given an exercise's original number, which lesson(s) contain
 * it; given free text, which lesson TITLES match it.
 *
 * PO follow-up (2026-10-07, lessons-list page): also return the subject's
 * linked textbook (`course_v2_packages.textbook_material_id`, see
 * `20261019100000_s35_textbook_page_link.sql`) so the caller can offer
 * "Відкрити сторінку підручника" straight from a hit — exactly the same
 * `materials` PDF id `mathCourseV2View.ts` resolves per-lesson, just once
 * here for the whole subject (one package per subject in practice).
 */

export interface MathCourseV2SearchLessonHit {
  id: string;
  title: string;
  kind: "lesson" | "review" | "assessment";
  printedPageFrom: number | null;
  printedPageTo: number | null;
}

export interface MathCourseV2SearchExerciseHit {
  lessonId: string;
  lessonTitle: string;
  exerciseId: string;
  originalNumber: string;
  displayMd: string;
  printedPage: number | null;
}

export interface MathCourseV2SearchTextbook {
  materialId: string;
  title: string;
  pageCount: number | null;
}

export interface MathCourseV2SearchResult {
  lessonsByPage: MathCourseV2SearchLessonHit[];
  lessonsByTopic: MathCourseV2SearchLessonHit[];
  exercisesByNumber: MathCourseV2SearchExerciseHit[];
  textbook: MathCourseV2SearchTextbook | null;
}

interface LessonRow {
  id: string;
  title: string;
  kind: "lesson" | "review" | "assessment";
  printed_page_from: number | null;
  printed_page_to: number | null;
  package_id: string;
}

async function getTextbookForPackage(scope: ReturnType<typeof forFamily>, packageId: string): Promise<MathCourseV2SearchTextbook | null> {
  const { data: pkg } = await scope.select("course_v2_packages", "textbook_material_id").eq("id", packageId).maybeSingle<{ textbook_material_id: string | null }>();
  if (!pkg?.textbook_material_id) return null;
  const { data: material } = await scope
    .select("materials", "title, name, page_count")
    .eq("id", pkg.textbook_material_id)
    .maybeSingle<{ title: string | null; name: string; page_count: number | null }>();
  if (!material) return null;
  return { materialId: pkg.textbook_material_id, title: material.title ?? material.name, pageCount: material.page_count };
}

/**
 * PO request 2026-10-07 ("з сторінки списку уроків відкрити підручник"): the
 * subject's own lessons-list screen needs to show "Відкрити підручник"
 * immediately, without the family making a search first — a cheap,
 * dedicated lookup for just that (no lesson/exercise rows).
 */
export async function getMathCourseV2TextbookForSubject(familyId: string, subjectId: string): Promise<MathCourseV2SearchTextbook | null> {
  const scope = forFamily(familyId);
  const { data: pkg } = await scope.select("course_v2_packages", "id").eq("subject_id", subjectId).limit(1).maybeSingle<{ id: string }>();
  if (!pkg) return null;
  return getTextbookForPackage(scope, pkg.id);
}

export async function searchMathCourseV2(
  familyId: string,
  subjectId: string,
  query: { page?: number; exerciseNumber?: string; topicQuery?: string },
): Promise<MathCourseV2SearchResult> {
  const scope = forFamily(familyId);
  const { data: lessons } = await scope
    .select("course_v2_lessons", "id, title, kind, printed_page_from, printed_page_to, package_id")
    .eq("subject_id", subjectId)
    .eq("status", "active")
    .returns<LessonRow[]>();
  const lessonRows = lessons ?? [];

  let lessonsByPage: MathCourseV2SearchLessonHit[] = [];
  if (query.page != null && Number.isFinite(query.page)) {
    lessonsByPage = lessonRows
      .filter((l) => {
        if (l.printed_page_from == null) return false;
        const to = l.printed_page_to ?? l.printed_page_from;
        return query.page! >= l.printed_page_from && query.page! <= to;
      })
      .map((l) => ({ id: l.id, title: l.title, kind: l.kind, printedPageFrom: l.printed_page_from, printedPageTo: l.printed_page_to }));
  }

  let lessonsByTopic: MathCourseV2SearchLessonHit[] = [];
  const topicQuery = query.topicQuery?.trim().toLocaleLowerCase("uk");
  if (topicQuery) {
    lessonsByTopic = lessonRows
      .filter((l) => l.title.toLocaleLowerCase("uk").includes(topicQuery))
      .map((l) => ({ id: l.id, title: l.title, kind: l.kind, printedPageFrom: l.printed_page_from, printedPageTo: l.printed_page_to }));
  }

  let exercisesByNumber: MathCourseV2SearchExerciseHit[] = [];
  const number = query.exerciseNumber?.trim();
  if (number) {
    const lessonIds = lessonRows.map((l) => l.id);
    const lessonById = new Map(lessonRows.map((l) => [l.id, l]));
    if (lessonIds.length > 0) {
      const { data: exercises } = await scope
        .select("course_v2_exercises", "id, lesson_id, original_number, display_md, printed_page")
        .in("lesson_id", lessonIds)
        .eq("original_number", number)
        .returns<{ id: string; lesson_id: string | null; original_number: string; display_md: string; printed_page: number | null }[]>();
      exercisesByNumber = (exercises ?? [])
        .filter((e) => e.lesson_id != null && lessonById.has(e.lesson_id))
        .map((e) => ({
          lessonId: e.lesson_id!,
          lessonTitle: lessonById.get(e.lesson_id!)!.title,
          exerciseId: e.id,
          originalNumber: e.original_number,
          displayMd: e.display_md,
          printedPage: e.printed_page,
        }));
    }
  }

  const packageId = lessonRows[0]?.package_id;
  const textbook = packageId ? await getTextbookForPackage(scope, packageId) : null;

  return { lessonsByPage, lessonsByTopic, exercisesByNumber, textbook };
}
