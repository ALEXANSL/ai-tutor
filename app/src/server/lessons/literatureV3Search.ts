import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S45 (part 3/4 of this slice) — `literature_v3`'s own version of
 * `literatureV2Search.ts`/`mathCourseV2Search.ts`: search by page number,
 * lesson title, or task label, same pattern. Also adds a genuinely NEW
 * capability over those two formats: search by WORK TITLE
 * (`literature_v3_works.title`) — this package is the first one whose
 * content actually HAS separate, named works (poems/stories) distinct from
 * the lesson that teaches them, so "Знайти твір «...»" is a real, valuable
 * addition here, not just parity with the older formats.
 */

export interface LiteratureV3SearchLessonHit {
  id: string;
  title: string;
  printedPageFrom: number | null;
  printedPageTo: number | null;
}

export interface LiteratureV3SearchWorkHit {
  id: string;
  title: string;
  author: string;
  /** Lessons whose `flow[]` includes at least one reading step for this work. */
  lessons: { id: string; title: string }[];
}

export interface LiteratureV3SearchResult {
  lessonsByPage: LiteratureV3SearchLessonHit[];
  lessonsByTopic: LiteratureV3SearchLessonHit[];
  worksByTitle: LiteratureV3SearchWorkHit[];
}

interface LessonRow {
  id: string;
  title: string;
  printed_page_from: number | null;
  printed_page_to: number | null;
  flow: { kind: "screen" | "biography" | "reading" | "quiz"; ref_id: string }[];
}

export async function searchLiteratureV3(
  familyId: string,
  subjectId: string,
  query: { page?: number; topicQuery?: string; workQuery?: string },
): Promise<LiteratureV3SearchResult> {
  const scope = forFamily(familyId);
  const { data: lessons } = await scope
    .select("literature_v3_lessons", "id, title, printed_page_from, printed_page_to, flow")
    .eq("subject_id", subjectId)
    .eq("status", "active")
    .returns<LessonRow[]>();
  const lessonRows = lessons ?? [];

  let lessonsByPage: LiteratureV3SearchLessonHit[] = [];
  if (query.page != null && Number.isFinite(query.page)) {
    lessonsByPage = lessonRows
      .filter((l) => {
        if (l.printed_page_from == null) return false;
        const to = l.printed_page_to ?? l.printed_page_from;
        return query.page! >= l.printed_page_from && query.page! <= to;
      })
      .map((l) => ({ id: l.id, title: l.title, printedPageFrom: l.printed_page_from, printedPageTo: l.printed_page_to }));
  }

  let lessonsByTopic: LiteratureV3SearchLessonHit[] = [];
  const topicQuery = query.topicQuery?.trim().toLocaleLowerCase("uk");
  if (topicQuery) {
    lessonsByTopic = lessonRows
      .filter((l) => l.title.toLocaleLowerCase("uk").includes(topicQuery))
      .map((l) => ({ id: l.id, title: l.title, printedPageFrom: l.printed_page_from, printedPageTo: l.printed_page_to }));
  }

  let worksByTitle: LiteratureV3SearchWorkHit[] = [];
  const workQuery = query.workQuery?.trim().toLocaleLowerCase("uk");
  if (workQuery && lessonRows.length > 0) {
    const { data: works } = await scope
      .select("literature_v3_works", "id, title, author")
      .ilike("title", `%${query.workQuery!.trim()}%`)
      .returns<{ id: string; title: string; author: string }[]>();
    const matchedWorks = (works ?? []).filter((w) => w.title.toLocaleLowerCase("uk").includes(workQuery));
    if (matchedWorks.length > 0) {
      const workIds = matchedWorks.map((w) => w.id);
      const { data: readingItems } = await scope.select("literature_v3_reading_items", "work_id, reading_key").in("work_id", workIds).returns<{ work_id: string; reading_key: string }[]>();
      const readingKeysByWorkId = new Map<string, Set<string>>();
      for (const r of readingItems ?? []) {
        if (!readingKeysByWorkId.has(r.work_id)) readingKeysByWorkId.set(r.work_id, new Set());
        readingKeysByWorkId.get(r.work_id)!.add(r.reading_key);
      }
      worksByTitle = matchedWorks.map((w) => {
        const readingKeys = readingKeysByWorkId.get(w.id) ?? new Set<string>();
        const lessonsForWork = lessonRows.filter((l) => l.flow.some((step) => step.kind === "reading" && readingKeys.has(step.ref_id)));
        return { id: w.id, title: w.title, author: w.author, lessons: lessonsForWork.map((l) => ({ id: l.id, title: l.title })) };
      });
    }
  }

  return { lessonsByPage, lessonsByTopic, worksByTitle };
}
