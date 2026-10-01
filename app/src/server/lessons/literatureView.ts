import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S33 minimal read path: fetches one `literature_lessons` row (+ its
 * `literature_lesson_tests` row) for display. No caching/warm-up here — the
 * PO's ask for this slice was "make it demonstrable today", not full
 * production wiring (a future slice can add it to the library warm-up path
 * like `library_items`, `warmup.ts`).
 */

export interface LiteratureQuestionGroupView {
  labelUk: string;
  page: number | null;
  pdfPage: number | null;
  items: { number: string; textUk: string }[];
}
export interface LiteratureSublessonView {
  no: string;
  titleUk: string;
  questionGroups: LiteratureQuestionGroupView[];
}
export interface LiteratureTestQuestionView {
  id: string;
  type: "single" | "multiple" | "truefalse" | "match" | "order" | "open";
  questionUk: string;
  options?: string[];
  answer?: number | number[] | string[];
  pairs?: { leftUk: string; rightUk: string }[];
  expectedAnswerUk?: string;
  explanationUk: string;
}
export interface LiteratureLessonView {
  id: string;
  /** PO feedback 2026-10-01: id of the book this lesson belongs to — lets the UI link to the full-book reader (`/literature/book/[materialId]`), which previously had no entry point from the lesson screen. */
  materialId: string;
  topicNo: number;
  sectionTitle: string | null;
  title: string;
  textbookPageFrom: number | null;
  textbookPageTo: number | null;
  pdfPageFrom: number | null;
  pdfPageTo: number | null;
  goalUk: string;
  keyConcepts: string[];
  explanationMd: string;
  work: {
    titleUk: string;
    excerptsUk: string;
    summaryUk: string;
    charactersUk: string | null;
    ideaUk: string | null;
    /** PO feedback 2026-10-01: a real author-biography paragraph, when the source text covers one — never invented. */
    authorBioUk: string | null;
    /** PO feedback 2026-10-01: other works of the author the source text itself mentions — never invented. */
    otherWorksUk: string | null;
  } | null;
  sublessons: LiteratureSublessonView[];
  teacherNoteUk: string;
  status: "active" | "needs_review";
  test: LiteratureTestQuestionView[];
  /**
   * PO correction 2026-09-30 (3rd/final): id of the small text file on the
   * family's own Google Drive holding the work's COMPLETE text (written by
   * `literatureExtraction.ts`'s `runLiteratureExtraction`) — never the text
   * itself, which is never stored in our DB. `null` when the topic has no
   * literary work, or the Drive write failed for this topic (Drive not
   * connected, etc. — see `RunLiteratureExtractionResult.driveWriteFailures`).
   * The UI fetches the actual text on demand through
   * `getLiteratureWorkFullTextAction` (`app/actions/literature.ts`), which
   * reads it via `drive/workText.ts`'s short in-memory TTL cache.
   */
  workFullTextDriveFileId: string | null;
}

interface LessonRow {
  id: string;
  material_id: string;
  topic_no: number;
  section_title: string | null;
  title: string;
  textbook_page_from: number | null;
  textbook_page_to: number | null;
  pdf_page_from: number | null;
  pdf_page_to: number | null;
  goal_uk: string;
  key_concepts: string[];
  explanation_md: string;
  work_title_uk: string | null;
  work_excerpts_uk: string | null;
  work_summary_uk: string | null;
  work_characters_uk: string | null;
  work_idea_uk: string | null;
  work_author_bio_uk: string | null;
  work_other_works_uk: string | null;
  work_full_text_drive_file_id: string | null;
  sublessons: LiteratureSublessonView[];
  teacher_note_uk: string;
  status: "active" | "needs_review";
}
interface TestRow {
  questions: LiteratureTestQuestionView[];
}

export async function getLiteratureLessonView(familyId: string, lessonId: string): Promise<LiteratureLessonView | null> {
  const scope = forFamily(familyId);
  const [{ data: lesson }, { data: test }] = await Promise.all([
    scope
      .select(
        "literature_lessons",
        "id, material_id, topic_no, section_title, title, textbook_page_from, textbook_page_to, pdf_page_from, pdf_page_to, goal_uk, key_concepts, explanation_md, work_title_uk, work_excerpts_uk, work_summary_uk, work_characters_uk, work_idea_uk, work_author_bio_uk, work_other_works_uk, work_full_text_drive_file_id, sublessons, teacher_note_uk, status",
      )
      .eq("id", lessonId)
      .maybeSingle<LessonRow>(),
    scope.select("literature_lesson_tests", "questions").eq("lesson_id", lessonId).maybeSingle<TestRow>(),
  ]);
  if (!lesson) return null;

  return {
    id: lesson.id,
    materialId: lesson.material_id,
    topicNo: lesson.topic_no,
    sectionTitle: lesson.section_title,
    title: lesson.title,
    textbookPageFrom: lesson.textbook_page_from,
    textbookPageTo: lesson.textbook_page_to,
    pdfPageFrom: lesson.pdf_page_from,
    pdfPageTo: lesson.pdf_page_to,
    goalUk: lesson.goal_uk,
    keyConcepts: lesson.key_concepts ?? [],
    explanationMd: lesson.explanation_md,
    work: lesson.work_title_uk
      ? {
          titleUk: lesson.work_title_uk,
          excerptsUk: lesson.work_excerpts_uk ?? "",
          summaryUk: lesson.work_summary_uk ?? "",
          charactersUk: lesson.work_characters_uk,
          ideaUk: lesson.work_idea_uk,
          authorBioUk: lesson.work_author_bio_uk,
          otherWorksUk: lesson.work_other_works_uk,
        }
      : null,
    sublessons: lesson.sublessons ?? [],
    teacherNoteUk: lesson.teacher_note_uk,
    status: lesson.status,
    test: test?.questions ?? [],
    workFullTextDriveFileId: lesson.work_full_text_drive_file_id,
  };
}

export interface LiteratureLessonListItem {
  id: string;
  topicNo: number;
  title: string;
  status: "active" | "needs_review";
}

export async function listLiteratureLessons(familyId: string, materialId: string): Promise<LiteratureLessonListItem[]> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("literature_lessons", "id, topic_no, title, status")
    .eq("material_id", materialId)
    .order("sort_order")
    .returns<{ id: string; topic_no: number; title: string; status: "active" | "needs_review" }[]>();
  return (data ?? []).map((r) => ({ id: r.id, topicNo: r.topic_no, title: r.title, status: r.status }));
}
