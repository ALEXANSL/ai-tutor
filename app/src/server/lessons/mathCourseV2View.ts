import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S35 read path for the child-facing `/math-course-v2/[lessonId]` screen.
 * NEVER returns `correct_option_id`, `exercise_solutions` or
 * `source_issues.issue` text — those live only behind
 * `submitQuestionAnswerAction`/`revealExerciseSolutionAction`
 * (`app/src/app/actions/math-course-v2.ts`), which read the private tables
 * through a service-role client AFTER the child has already answered/asked
 * (package contract: "Ключі не передаються перед відповіддю").
 *
 * Mirrors `courseView.ts` (S34)'s signed-URL-on-demand convention for
 * images, but most content here is plain `display_md`/`narration` text —
 * images are the exception (35 figures), not the rule.
 */

const SIGNED_URL_TTL_S = 600;
const COURSE_ASSETS_BUCKET = "course_assets";

export interface MathV2ScreenView {
  id: string;
  order: number;
  role: string;
  title: string;
  displayMd: string;
  narration: string;
  pauseAfter: boolean;
}

export interface MathV2QuestionOptionView {
  id: string;
  displayMd: string;
}

export interface MathV2QuestionView {
  id: string;
  displayMd: string;
  narration: string;
  maxPoints: number;
  options: MathV2QuestionOptionView[];
}

export interface MathV2AssetView {
  assetKey: string;
  url: string | null;
  alt: string;
  mimeType: string;
  isConstructionTemplate: boolean;
  physicalWidthMm: number | null;
  physicalHeightMm: number | null;
}

export interface MathV2ExerciseView {
  id: string;
  exerciseKey: string;
  originalNumber: string;
  displayMd: string;
  narration: string;
  assets: MathV2AssetView[];
  hasConstructionTemplate: boolean;
  hasSourceIssue: boolean;
  printedPage: number | null;
}

export interface MathV2LessonView {
  id: string;
  subjectId: string;
  /** For the on-demand tutor chat ("поясни задачу/урок") — null only if the
   * importer couldn't attach a topic (never expected in practice, see
   * `mathCourseV2Persist.ts`). */
  topicId: string | null;
  packageId: string;
  packageTitle: string;
  lessonKey: string;
  kind: "lesson" | "review" | "assessment";
  title: string;
  objectives: string[];
  printedPageFrom: number | null;
  printedPageTo: number | null;
  /** The uploaded PDF `materials` row these page numbers map to — null until
   * a parent links it (see `20261019100000_s35_textbook_page_link.sql`),
   * in which case "Відкрити сторінку підручника" simply doesn't render. */
  textbookMaterialId: string | null;
  textbookTitle: string | null;
  textbookPageCount: number | null;
  screens: MathV2ScreenView[];
  quizTitle: string | null;
  quizQuestions: MathV2QuestionView[];
  exercises: MathV2ExerciseView[];
  status: "active" | "needs_review";
}

interface LessonRow {
  id: string;
  subject_id: string;
  topic_id: string | null;
  package_id: string;
  lesson_key: string;
  kind: "lesson" | "review" | "assessment";
  title: string;
  objectives: string[];
  printed_page_from: number | null;
  printed_page_to: number | null;
  status: "active" | "needs_review";
}
interface ScreenRow {
  id: string;
  screen_key: string;
  order_no: number;
  role: string;
  title: string;
  display_md: string;
  narration: string;
  pause_after: boolean;
}
interface QuizRow {
  id: string;
  title: string;
}
interface QuestionRow {
  id: string;
  question_key: string;
  max_points: number;
  display_md: string;
  narration: string;
  options: { id: string; display_md: string; narration: string }[];
}
interface ExerciseRow {
  id: string;
  exercise_key: string;
  original_number: string;
  display_md: string;
  narration: string;
  asset_ids: string[];
  has_construction_template: boolean;
  has_source_issue: boolean;
  printed_page: number | null;
}
interface AssetRow {
  asset_key: string;
  storage_path: string;
  mime_type: string;
  alt: string;
  is_construction_template: boolean;
  physical_width_mm: number | null;
  physical_height_mm: number | null;
}

async function signAssets(client: ReturnType<typeof forFamily>["client"], packageId: string, assetKeys: string[]): Promise<Map<string, MathV2AssetView>> {
  const distinct = [...new Set(assetKeys)];
  if (distinct.length === 0) return new Map();
  const { data: rows } = await client
    .from("course_v2_assets")
    .select("asset_key, storage_path, mime_type, alt, is_construction_template, physical_width_mm, physical_height_mm")
    .eq("package_id", packageId)
    .in("asset_key", distinct)
    .returns<AssetRow[]>();
  const byKey = new Map((rows ?? []).map((r) => [r.asset_key, r]));
  const storagePaths = (rows ?? []).map((r) => r.storage_path);
  const { data: signed } = storagePaths.length ? await client.storage.from(COURSE_ASSETS_BUCKET).createSignedUrls(storagePaths, SIGNED_URL_TTL_S) : { data: [] };
  const urlByStoragePath = new Map((signed ?? []).filter((s) => !s.error).map((s) => [s.path ?? "", s.signedUrl]));

  const result = new Map<string, MathV2AssetView>();
  for (const [key, row] of byKey) {
    result.set(key, {
      assetKey: key,
      url: urlByStoragePath.get(row.storage_path) ?? null,
      alt: row.alt,
      mimeType: row.mime_type,
      isConstructionTemplate: row.is_construction_template,
      physicalWidthMm: row.physical_width_mm,
      physicalHeightMm: row.physical_height_mm,
    });
  }
  return result;
}

export async function getMathCourseV2LessonView(familyId: string, lessonId: string): Promise<MathV2LessonView | null> {
  const scope = forFamily(familyId);
  const { data: lesson } = await scope
    .select("course_v2_lessons", "id, subject_id, topic_id, package_id, lesson_key, kind, title, objectives, printed_page_from, printed_page_to, status")
    .eq("id", lessonId)
    .maybeSingle<LessonRow>();
  if (!lesson) return null;

  const [{ data: pkg }, { data: screens }, { data: quiz }, { data: exerciseRows }] = await Promise.all([
    scope.select("course_v2_packages", "title, textbook_material_id").eq("id", lesson.package_id).maybeSingle<{ title: string; textbook_material_id: string | null }>(),
    scope.select("course_v2_screens", "id, screen_key, order_no, role, title, display_md, narration, pause_after").eq("lesson_id", lessonId).order("order_no").returns<ScreenRow[]>(),
    scope.select("course_v2_quizzes", "id, title").eq("lesson_id", lessonId).maybeSingle<QuizRow>(),
    scope
      .select("course_v2_exercises", "id, exercise_key, original_number, display_md, narration, asset_ids, has_construction_template, has_source_issue, printed_page")
      .eq("lesson_id", lessonId)
      .returns<ExerciseRow[]>(),
  ]);

  let textbookTitle: string | null = null;
  let textbookPageCount: number | null = null;
  if (pkg?.textbook_material_id) {
    const { data: material } = await scope
      .select("materials", "title, name, page_count")
      .eq("id", pkg.textbook_material_id)
      .maybeSingle<{ title: string | null; name: string; page_count: number | null }>();
    if (material) {
      textbookTitle = material.title ?? material.name;
      textbookPageCount = material.page_count;
    }
  }

  let quizQuestions: MathV2QuestionView[] = [];
  if (quiz) {
    const { data: items } = await scope.client
      .from("course_v2_quiz_items")
      .select("order_no, course_v2_questions(id, question_key, max_points, display_md, narration, options)")
      .eq("quiz_id", quiz.id)
      .order("order_no")
      .returns<{ order_no: number; course_v2_questions: QuestionRow | null }[]>();
    quizQuestions = (items ?? [])
      .map((it) => it.course_v2_questions)
      .filter((q): q is QuestionRow => q != null)
      .map((q) => ({
        id: q.id,
        displayMd: q.display_md,
        narration: q.narration,
        maxPoints: q.max_points,
        options: q.options.map((o) => ({ id: o.id, displayMd: o.display_md })),
      }));
  }

  // PO feedback 2026-10-07: exercises rendered as "№1, №10, №11, №12…,
  // №2, №20…" — `original_number` is TEXT (it is a textbook number, can in
  // principle be non-numeric), so a plain DB `.order()` sorted it
  // alphabetically. Sort numerically here, falling back to the original
  // (already-imported) order for anything that doesn't parse as a plain
  // integer rather than silently misplacing it.
  const sortedExerciseRows = [...(exerciseRows ?? [])].sort((a, b) => {
    const an = Number.parseInt(a.original_number, 10);
    const bn = Number.parseInt(b.original_number, 10);
    if (Number.isNaN(an) || Number.isNaN(bn)) return a.original_number.localeCompare(b.original_number);
    return an - bn;
  });

  const assetKeys = sortedExerciseRows.flatMap((e) => e.asset_ids);
  const assetByKey = await signAssets(scope.client, lesson.package_id, assetKeys);

  return {
    id: lesson.id,
    subjectId: lesson.subject_id,
    topicId: lesson.topic_id,
    packageId: lesson.package_id,
    packageTitle: pkg?.title ?? "",
    lessonKey: lesson.lesson_key,
    kind: lesson.kind,
    title: lesson.title,
    objectives: lesson.objectives ?? [],
    printedPageFrom: lesson.printed_page_from,
    printedPageTo: lesson.printed_page_to,
    textbookMaterialId: pkg?.textbook_material_id ?? null,
    textbookTitle,
    textbookPageCount,
    screens: (screens ?? []).map((s) => ({ id: s.id, order: s.order_no, role: s.role, title: s.title, displayMd: s.display_md, narration: s.narration, pauseAfter: s.pause_after })),
    quizTitle: quiz?.title ?? null,
    quizQuestions,
    exercises: sortedExerciseRows.map((e) => ({
      id: e.id,
      exerciseKey: e.exercise_key,
      originalNumber: e.original_number,
      displayMd: e.display_md,
      narration: e.narration,
      assets: e.asset_ids.map((id) => assetByKey.get(id)).filter((a): a is MathV2AssetView => a != null),
      hasConstructionTemplate: e.has_construction_template,
      hasSourceIssue: e.has_source_issue,
      printedPage: e.printed_page,
    })),
    status: lesson.status,
  };
}

export interface MathCourseV2LessonListItem {
  id: string;
  orderNo: number;
  kind: "lesson" | "review" | "assessment";
  title: string;
  status: "active" | "needs_review";
}

export async function listMathCourseV2Lessons(familyId: string, packageId: string): Promise<MathCourseV2LessonListItem[]> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("course_v2_lessons", "id, order_no, kind, title, status")
    .eq("package_id", packageId)
    .order("order_no")
    .returns<{ id: string; order_no: number; kind: "lesson" | "review" | "assessment"; title: string; status: "active" | "needs_review" }[]>();
  return (data ?? []).map((r) => ({ id: r.id, orderNo: r.order_no, kind: r.kind, title: r.title, status: r.status }));
}

/** Same role as `courseView.ts`'s `getActiveCourseLessonIdForTopic` (see its doc comment). */
export async function getActiveMathCourseV2LessonIdForTopic(familyId: string, topicId: string): Promise<string | null> {
  const scope = forFamily(familyId);
  const { data } = await scope.select("course_v2_lessons", "id").eq("topic_id", topicId).eq("status", "active").limit(1).maybeSingle<{ id: string }>();
  return data?.id ?? null;
}
