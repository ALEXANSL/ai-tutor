import "server-only";
import { forFamily } from "@/server/db/family-scope";

/**
 * S36 read path for the child-facing `/literature-course-v2/[lessonId]`
 * screen. NEVER returns hints/model-answer/criteria/misconceptions — those
 * live only behind `revealLiteratureV2TaskHelpAction`
 * (`app/src/app/actions/literature-course-v2.ts`), which reads the private
 * `literature_v2_task_keys` table through a service-role client. Mirrors
 * `mathCourseV2View.ts`'s conventions closely (signed-URL-on-demand for
 * images, a `hasHint` flag instead of the key content itself).
 */

const SIGNED_URL_TTL_S = 600;
const COURSE_ASSETS_BUCKET = "course_assets";

export interface RichTextView {
  display: string;
  tts: { text: string; lang: string; segments?: { text: string; lang: string }[] };
}

export interface LiteratureV2AssetView {
  assetKey: string;
  url: string | null;
  caption: string;
  alt: string;
  tts: RichTextView["tts"] | null;
}

export interface LiteratureV2ScreenView {
  id: string;
  order: number;
  stepType: string;
  content: RichTextView;
  tutorAction: string;
  assets: LiteratureV2AssetView[];
}

export interface LiteratureV2TaskTableView {
  columns: string[];
  rows: string[][];
  emptyCellsAreStudentInput: boolean;
}

export interface LiteratureV2TaskView {
  id: string;
  originalLabel: string;
  prompt: RichTextView;
  subtasks: { id: string; label: string; display: string; tts: RichTextView["tts"] }[];
  responseType: string;
  printedPage: number | null;
  hasHint: boolean;
  table: LiteratureV2TaskTableView | null;
  /** PO complaint 2026-10-08: a task like "Розгляньте картину Шардена…"
   * referenced an illustration only by TEXT, with no image or page link
   * anywhere near it. The package links illustrations to a PAGE (`asset_
   * refs` on a task is a list of page ids, `literature_v2_assets.page_id`
   * matches it — see `getLiteratureV2LessonView`), not to a task directly,
   * so this is resolved at view time instead of import time. */
  assets: LiteratureV2AssetView[];
}

export interface LiteratureV2DefinitionView {
  term: string;
  explanation: RichTextView;
}

export interface LiteratureV2WorkedExampleView {
  steps: RichTextView[];
}

export interface LiteratureV2LessonView {
  id: string;
  subjectId: string;
  topicId: string | null;
  packageId: string;
  packageTitle: string;
  lessonKey: string;
  title: string;
  estimatedMinutes: number | null;
  objectives: string[];
  prerequisites: string[];
  explanation: RichTextView[];
  definitions: LiteratureV2DefinitionView[];
  workedExample: LiteratureV2WorkedExampleView | null;
  screens: LiteratureV2ScreenView[];
  tasks: LiteratureV2TaskView[];
  printedPageFrom: number | null;
  printedPageTo: number | null;
  status: "active" | "needs_review";
}

interface LessonRow {
  id: string;
  subject_id: string;
  topic_id: string | null;
  package_id: string;
  lesson_key: string;
  title: string;
  estimated_minutes: number | null;
  objectives: string[];
  prerequisites: string[];
  explanation: RichTextView[];
  definitions: { term: string; explanation: RichTextView }[];
  worked_example: { origin: string; steps: RichTextView[] } | null;
  task_ids: string[];
  printed_page_from: number | null;
  printed_page_to: number | null;
  status: "active" | "needs_review";
}
interface ScreenRow {
  id: string;
  screen_key: string;
  order_no: number;
  step_type: string;
  content_display: string;
  content_tts: RichTextView["tts"];
  tutor_action: string;
  asset_ids: string[];
}
interface TaskRow {
  id: string;
  task_key: string;
  original_label: string;
  prompt_display: string;
  prompt_tts: RichTextView["tts"];
  subtasks: { id: string; label: string; display: string; tts: RichTextView["tts"] }[];
  response_type: string;
  printed_page: number | null;
  has_hint: boolean;
  asset_refs: string[];
}
interface AssetRow {
  asset_key: string;
  page_id: string;
  storage_path: string | null;
  caption: string;
  alt: string;
  tts: RichTextView["tts"] | null;
}
interface TaskTableRow {
  task_id: string;
  columns: string[];
  rows: string[][];
  empty_cells_are_student_input: boolean;
}

/**
 * Fetches every illustration in the package (typically ~30, cheap for one
 * lesson view) and signs its storage URL, returning both lookups the
 * caller needs: by the package's own asset key (screens' `asset_ids`) and
 * by the page it illustrates (tasks' `asset_refs` — see
 * `LiteratureV2TaskView.assets`'s own doc comment for why a task links to
 * an illustration via its page, not directly).
 */
async function signPackageAssets(client: ReturnType<typeof forFamily>["client"], packageId: string): Promise<{ byAssetKey: Map<string, LiteratureV2AssetView>; byPageId: Map<string, LiteratureV2AssetView[]> }> {
  const { data: rows } = await client.from("literature_v2_assets").select("asset_key, page_id, storage_path, caption, alt, tts").eq("package_id", packageId).returns<AssetRow[]>();
  const storagePaths = (rows ?? []).filter((r) => r.storage_path).map((r) => r.storage_path as string);
  const { data: signed } = storagePaths.length ? await client.storage.from(COURSE_ASSETS_BUCKET).createSignedUrls(storagePaths, SIGNED_URL_TTL_S) : { data: [] };
  const urlByStoragePath = new Map((signed ?? []).filter((s) => !s.error).map((s) => [s.path ?? "", s.signedUrl]));

  const byAssetKey = new Map<string, LiteratureV2AssetView>();
  const byPageId = new Map<string, LiteratureV2AssetView[]>();
  for (const row of rows ?? []) {
    const view: LiteratureV2AssetView = {
      assetKey: row.asset_key,
      url: row.storage_path ? (urlByStoragePath.get(row.storage_path) ?? null) : null,
      caption: row.caption,
      alt: row.alt,
      tts: row.tts,
    };
    byAssetKey.set(row.asset_key, view);
    if (row.page_id) byPageId.set(row.page_id, [...(byPageId.get(row.page_id) ?? []), view]);
  }
  return { byAssetKey, byPageId };
}

export async function getLiteratureV2LessonView(familyId: string, lessonId: string): Promise<LiteratureV2LessonView | null> {
  const scope = forFamily(familyId);
  const { data: lesson } = await scope
    .select(
      "literature_v2_lessons",
      "id, subject_id, topic_id, package_id, lesson_key, title, estimated_minutes, objectives, prerequisites, explanation, definitions, worked_example, task_ids, printed_page_from, printed_page_to, status",
    )
    .eq("id", lessonId)
    .maybeSingle<LessonRow>();
  if (!lesson) return null;

  const [{ data: pkg }, { data: screenRows }, { data: taskRows }] = await Promise.all([
    scope.select("literature_v2_packages", "title").eq("id", lesson.package_id).maybeSingle<{ title: string }>(),
    scope.select("literature_v2_screens", "id, screen_key, order_no, step_type, content_display, content_tts, tutor_action, asset_ids").eq("lesson_id", lessonId).order("order_no").returns<ScreenRow[]>(),
    scope
      .select("literature_v2_tasks", "id, task_key, original_label, prompt_display, prompt_tts, subtasks, response_type, printed_page, has_hint, asset_refs")
      .eq("lesson_id", lessonId)
      .returns<TaskRow[]>(),
  ]);

  const taskIds = (taskRows ?? []).map((t) => t.id);
  const { data: taskTableRows } = taskIds.length
    ? await scope.select("literature_v2_task_tables", "task_id, columns, rows, empty_cells_are_student_input").in("task_id", taskIds).returns<TaskTableRow[]>()
    : { data: [] as TaskTableRow[] };

  const tableByTaskId = new Map((taskTableRows ?? []).map((r) => [r.task_id, r]));

  const { byAssetKey: assetByKey, byPageId: assetsByPageId } = await signPackageAssets(scope.client, lesson.package_id);

  const taskByKey = new Map((taskRows ?? []).map((t) => [t.task_key, t]));
  const orderedTasks = lesson.task_ids.map((key) => taskByKey.get(key)).filter((t): t is TaskRow => t != null);
  // Any task not listed in task_ids (shouldn't happen, defensive) still shows, appended at the end.
  for (const t of taskRows ?? []) if (!lesson.task_ids.includes(t.task_key)) orderedTasks.push(t);

  return {
    id: lesson.id,
    subjectId: lesson.subject_id,
    topicId: lesson.topic_id,
    packageId: lesson.package_id,
    packageTitle: pkg?.title ?? "",
    lessonKey: lesson.lesson_key,
    title: lesson.title,
    estimatedMinutes: lesson.estimated_minutes,
    objectives: lesson.objectives ?? [],
    prerequisites: lesson.prerequisites ?? [],
    explanation: lesson.explanation ?? [],
    definitions: lesson.definitions ?? [],
    workedExample: lesson.worked_example ? { steps: lesson.worked_example.steps } : null,
    screens: (screenRows ?? []).map((s) => ({
      id: s.id,
      order: s.order_no,
      stepType: s.step_type,
      content: { display: s.content_display, tts: s.content_tts },
      tutorAction: s.tutor_action,
      assets: s.asset_ids.map((id) => assetByKey.get(id)).filter((a): a is LiteratureV2AssetView => a != null),
    })),
    tasks: orderedTasks.map((t) => {
      const table = tableByTaskId.get(t.id);
      return {
        id: t.id,
        originalLabel: t.original_label,
        prompt: { display: t.prompt_display, tts: t.prompt_tts },
        subtasks: t.subtasks,
        responseType: t.response_type,
        printedPage: t.printed_page,
        hasHint: t.has_hint,
        table: table ? { columns: table.columns, rows: table.rows, emptyCellsAreStudentInput: table.empty_cells_are_student_input } : null,
        assets: (t.asset_refs ?? []).flatMap((pageId) => assetsByPageId.get(pageId) ?? []),
      };
    }),
    printedPageFrom: lesson.printed_page_from,
    printedPageTo: lesson.printed_page_to,
    status: lesson.status,
  };
}

export interface LiteratureV2LessonListItem {
  id: string;
  orderNo: number;
  title: string;
  status: "active" | "needs_review";
}

export async function listLiteratureV2Lessons(familyId: string, packageId: string): Promise<LiteratureV2LessonListItem[]> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("literature_v2_lessons", "id, order_no, title, status")
    .eq("package_id", packageId)
    .order("order_no")
    .returns<{ id: string; order_no: number; title: string; status: "active" | "needs_review" }[]>();
  return (data ?? []).map((r) => ({ id: r.id, orderNo: r.order_no, title: r.title, status: r.status }));
}

/** Same role as `mathCourseV2View.ts`'s `getActiveMathCourseV2LessonIdForTopic`. */
export async function getActiveLiteratureV2LessonIdForTopic(familyId: string, topicId: string): Promise<string | null> {
  const scope = forFamily(familyId);
  const { data } = await scope.select("literature_v2_lessons", "id").eq("topic_id", topicId).eq("status", "active").limit(1).maybeSingle<{ id: string }>();
  return data?.id ?? null;
}
