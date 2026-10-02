import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S34 read path for the child-facing course-lesson screen
 * (`/course-lesson/[lessonId]`) — mirrors `literatureView.ts`'s shape and
 * conventions closely (same reasons: no caching/warm-up here, "ready
 * today" over full production polish for exercises).
 *
 * Images are NEVER returned as raw/stored URLs — every `url` field here is
 * a short-lived SIGNED url minted on demand (`course_assets` bucket is
 * private; see the migration header for why this bucket, unlike
 * `literature_lessons`' Drive-based full-text policy, is the right choice
 * for THIS package's images).
 */

const SIGNED_URL_TTL_S = 600; // 10 minutes — long enough for one lesson view, short enough to never be a durable link.
const COURSE_ASSETS_BUCKET = "course_assets";

export interface CourseSourceImageView {
  assetId: string | null;
  url: string | null;
  printedPage: number | null;
  pdfPage: number | null;
  searchTextOcr: string | null;
}

export interface CourseAutomaticQuestionView {
  id: string;
  promptMd: string;
  options: { id: string; textMd: string }[];
  correctOptionId: string;
  explanationMd: string;
  maxPoints: number;
}

export interface CourseExerciseView {
  exerciseKey: string;
  originalNumber: string;
  images: CourseSourceImageView[];
  measurementWarning: boolean;
}

export interface CourseLessonView {
  id: string;
  packageId: string;
  packageTitle: string;
  lessonKey: string;
  kind: "lesson" | "review" | "assessment";
  title: string;
  printedPageFrom: number | null;
  printedPageTo: number | null;
  teacherNotesMd: string;
  sourceImages: CourseSourceImageView[];
  automaticQuestions: CourseAutomaticQuestionView[];
  exercises: CourseExerciseView[];
  exerciseTotalCount: number;
  status: "active" | "needs_review";
}

interface LessonRow {
  id: string;
  package_id: string;
  lesson_key: string;
  kind: "lesson" | "review" | "assessment";
  title: string;
  source: { printedPages?: number[] } | Record<string, unknown>;
  teacher_notes_md: string;
  source_material: { assetId: string | null; path: string; source: { printedPage: number | null; pdfPage: number | null }; searchTextOcr: string | null }[];
  exercise_ids: string[];
  exercise_count: number;
  status: "active" | "needs_review";
}
interface TestRow {
  automatic_questions: {
    id: string;
    promptMd: string;
    options: { id: string; textMd: string }[];
    correctOptionId: string;
    explanationMd: string;
    maxPoints: number;
  }[];
}
interface ExerciseRow {
  exercise_key: string;
  original_number: string;
  content: { assetId: string | null; path: string; source: { printedPage: number | null; pdfPage: number | null }; searchTextOcr: string | null }[];
  measurement_warning: boolean;
}

/** Signs every distinct asset path referenced by `sourceMaterial`/exercise `content` blocks in one batch call. */
async function signAssetPaths(
  client: ReturnType<typeof forFamily>["client"],
  packageId: string,
  assetPaths: string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(assetPaths)];
  if (distinct.length === 0) return new Map();
  const { data: rows } = await client
    .from("course_package_assets")
    .select("source_path, storage_path")
    .eq("package_id", packageId)
    .in("source_path", distinct)
    .returns<{ source_path: string; storage_path: string }[]>();
  const storageByPath = new Map((rows ?? []).map((r) => [r.source_path, r.storage_path]));

  const storagePaths = [...storageByPath.values()];
  if (storagePaths.length === 0) return new Map();
  const { data: signed } = await client.storage.from(COURSE_ASSETS_BUCKET).createSignedUrls(storagePaths, SIGNED_URL_TTL_S);
  const urlByStoragePath = new Map((signed ?? []).filter((s) => !s.error).map((s) => [s.path ?? "", s.signedUrl]));

  const result = new Map<string, string>();
  for (const [sourcePath, storagePath] of storageByPath) {
    const url = urlByStoragePath.get(storagePath);
    if (url) result.set(sourcePath, url);
  }
  return result;
}

function toImageView(
  blocks: { assetId: string | null; path: string; source: { printedPage: number | null; pdfPage: number | null }; searchTextOcr: string | null }[],
  urlByPath: Map<string, string>,
): CourseSourceImageView[] {
  return blocks.map((b) => ({
    assetId: b.assetId,
    url: urlByPath.get(b.path) ?? null,
    printedPage: b.source?.printedPage ?? null,
    pdfPage: b.source?.pdfPage ?? null,
    searchTextOcr: b.searchTextOcr,
  }));
}

export async function getCourseLessonView(familyId: string, lessonId: string): Promise<CourseLessonView | null> {
  const scope = forFamily(familyId);
  const [{ data: lesson }, { data: test }] = await Promise.all([
    scope
      .select(
        "course_lessons",
        "id, package_id, lesson_key, kind, title, source, teacher_notes_md, source_material, exercise_ids, exercise_count, status",
      )
      .eq("id", lessonId)
      .maybeSingle<LessonRow>(),
    scope.select("course_lesson_tests", "automatic_questions").eq("lesson_id", lessonId).maybeSingle<TestRow>(),
  ]);
  if (!lesson) return null;

  const { data: pkg } = await scope.select("course_packages", "title").eq("id", lesson.package_id).maybeSingle<{ title: string }>();

  // Lower-priority exercises (brief: "довідкові приклади з підручника",
  // simple list only) — only the first few, so one lesson view never has to
  // sign dozens of images it won't realistically show.
  const EXERCISE_PREVIEW_LIMIT = 8;
  const { data: exerciseRows } = lesson.exercise_ids.length
    ? await scope
        .select("course_exercises", "exercise_key, original_number, content, measurement_warning")
        .eq("lesson_id", lessonId)
        .order("original_number")
        .limit(EXERCISE_PREVIEW_LIMIT)
        .returns<ExerciseRow[]>()
    : { data: [] as ExerciseRow[] };

  const allPaths = [
    ...lesson.source_material.map((b) => b.path),
    ...(exerciseRows ?? []).flatMap((e) => e.content.map((b) => b.path)),
  ];
  const urlByPath = await signAssetPaths(scope.client, lesson.package_id, allPaths);

  const printedPages = Array.isArray((lesson.source as { printedPages?: number[] }).printedPages)
    ? (lesson.source as { printedPages: number[] }).printedPages
    : [];

  return {
    id: lesson.id,
    packageId: lesson.package_id,
    packageTitle: pkg?.title ?? "",
    lessonKey: lesson.lesson_key,
    kind: lesson.kind,
    title: lesson.title,
    printedPageFrom: printedPages[0] ?? null,
    printedPageTo: printedPages[printedPages.length - 1] ?? null,
    teacherNotesMd: lesson.teacher_notes_md,
    sourceImages: toImageView(lesson.source_material, urlByPath),
    automaticQuestions: (test?.automatic_questions ?? []).map((q) => ({
      id: q.id,
      promptMd: q.promptMd,
      options: q.options,
      correctOptionId: q.correctOptionId,
      explanationMd: q.explanationMd,
      maxPoints: q.maxPoints,
    })),
    exercises: (exerciseRows ?? []).map((e) => ({
      exerciseKey: e.exercise_key,
      originalNumber: e.original_number,
      images: toImageView(e.content, urlByPath),
      measurementWarning: e.measurement_warning,
    })),
    exerciseTotalCount: lesson.exercise_count,
    status: lesson.status,
  };
}

/** Same role as `literatureView.ts`'s `getActiveLiteratureLessonIdForTopic` — see its doc comment (`/lesson/[sessionId]` safety net). */
export async function getActiveCourseLessonIdForTopic(familyId: string, topicId: string): Promise<string | null> {
  const scope = forFamily(familyId);
  const { data } = await scope.select("course_lessons", "id").eq("topic_id", topicId).eq("status", "active").limit(1).maybeSingle<{ id: string }>();
  return data?.id ?? null;
}
