import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S35 follow-up (PO request 2026-10-07): "пошук уроків за сторінкою в книзі
 * або за номером задачі" — this package has no page images/PDF to search
 * (see `mathCourseV2Import.ts`'s header), so this searches the already-
 * imported structured lesson/exercise metadata instead: given a textbook
 * page number, which lesson(s) cover it; given an exercise's original
 * number, which lesson(s) contain it. Read-only, no new table.
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
}

export interface MathCourseV2SearchResult {
  lessonsByPage: MathCourseV2SearchLessonHit[];
  exercisesByNumber: MathCourseV2SearchExerciseHit[];
}

interface LessonRow {
  id: string;
  title: string;
  kind: "lesson" | "review" | "assessment";
  printed_page_from: number | null;
  printed_page_to: number | null;
}

export async function searchMathCourseV2(
  familyId: string,
  subjectId: string,
  query: { page?: number; exerciseNumber?: string },
): Promise<MathCourseV2SearchResult> {
  const scope = forFamily(familyId);
  const { data: lessons } = await scope
    .select("course_v2_lessons", "id, title, kind, printed_page_from, printed_page_to")
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

  let exercisesByNumber: MathCourseV2SearchExerciseHit[] = [];
  const number = query.exerciseNumber?.trim();
  if (number) {
    const lessonIds = lessonRows.map((l) => l.id);
    const lessonById = new Map(lessonRows.map((l) => [l.id, l]));
    if (lessonIds.length > 0) {
      const { data: exercises } = await scope
        .select("course_v2_exercises", "id, lesson_id, original_number, display_md")
        .in("lesson_id", lessonIds)
        .eq("original_number", number)
        .returns<{ id: string; lesson_id: string | null; original_number: string; display_md: string }[]>();
      exercisesByNumber = (exercises ?? [])
        .filter((e) => e.lesson_id != null && lessonById.has(e.lesson_id))
        .map((e) => ({
          lessonId: e.lesson_id!,
          lessonTitle: lessonById.get(e.lesson_id!)!.title,
          exerciseId: e.id,
          originalNumber: e.original_number,
          displayMd: e.display_md,
        }));
    }
  }

  return { lessonsByPage, exercisesByNumber };
}
