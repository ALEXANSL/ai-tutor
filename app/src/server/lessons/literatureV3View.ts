import "server-only";
import { forFamily } from "@/server/db/family-scope";
import type { CourseV2QuestionView } from "@/components/course-v2/QuestionCard";

const SIGNED_URL_TTL_S = 600;
const LIT_V3_ASSETS_BUCKET = "course_assets"; // shared bucket (S34/S35/S36), same as `literatureV3Persist.ts`'s own constant.

/**
 * S45 read path for the child-facing `/literature-v3/[lessonId]` screen.
 * Mirrors `mathCourseV2View.ts`'s conventions (never returns
 * `correct_option_id`/`option_feedback`'s is_correct — those live only
 * behind `submitQuestionAnswerAction`, which already works unchanged for
 * these rows, see `literatureV3Persist.ts`'s header).
 *
 * The one new idea here is `flow[]`: `literature_v3_lessons.flow` is an
 * ordered `{kind, ref_id}[]` (ADR-044 §1) — this view resolves each step
 * into the CONCRETE row the viewer needs (`screen`/`biography`/`reading`
 * already-fetched content; `quiz` → the same `CourseV2QuestionView` shape
 * `QuestionCard` already renders for math), in the package's own order. A
 * step whose `ref_id` doesn't resolve (reported as an import warning
 * already — see `literatureV3Import.ts`'s `combineLiteratureV3Package`) is
 * simply skipped here, never shown as a broken step.
 */

export interface LiteratureV3IllustrationView {
  assetKey: string;
  url: string | null;
  caption: string;
  alt: string;
}

export interface LiteratureV3ScreenStep {
  kind: "screen";
  id: string;
  title: string;
  displayText: string;
  ttsText: string;
  illustrations: LiteratureV3IllustrationView[];
}

export interface LiteratureV3BiographyStep {
  kind: "biography";
  id: string;
  authorName: string;
  displayText: string;
  ttsText: string;
}

export interface LiteratureV3ReadingStep {
  kind: "reading";
  id: string;
  workTitle: string;
  workAuthor: string;
  title: string;
  displayText: string;
  ttsText: string;
  /** US-31.3: printed-book page this fragment starts on, when known (`literature_v3_reading_items.primary_page_id` resolved against `literature_v3_pages`) — lets "📖 Подивитись у підручнику" open the virtual book at the RIGHT page for this step, not just the lesson's first page. */
  bookPage: number | null;
}

export interface LiteratureV3QuizStep {
  kind: "quiz";
  id: string;
  question: CourseV2QuestionView;
}

export type LiteratureV3FlowStep = LiteratureV3ScreenStep | LiteratureV3BiographyStep | LiteratureV3ReadingStep | LiteratureV3QuizStep;

export interface LiteratureV3LessonView {
  id: string;
  subjectId: string;
  topicId: string | null;
  packageId: string;
  packageTitle: string;
  lessonKey: string;
  title: string;
  objectives: string[];
  printedPageFrom: number | null;
  printedPageTo: number | null;
  flow: LiteratureV3FlowStep[];
  status: "active" | "needs_review";
}

interface LessonRow {
  id: string;
  subject_id: string;
  topic_id: string | null;
  package_id: string;
  lesson_key: string;
  title: string;
  objectives: string[];
  printed_page_from: number | null;
  printed_page_to: number | null;
  flow: { kind: "screen" | "biography" | "reading" | "quiz"; ref_id: string }[];
  status: "active" | "needs_review";
}
interface ScreenRow {
  id: string;
  screen_key: string;
  title: string;
  content_display: string;
  content_tts: { text?: string };
  asset_ids: string[];
}
interface IllustrationAssetRow {
  asset_key: string;
  storage_path: string | null;
  caption: string;
  alt: string;
}
interface ReadingItemRow {
  id: string;
  reading_key: string;
  title: string;
  content_display: string;
  content_tts: { text?: string };
  work_id: string;
  primary_page_id: string | null;
}
interface WorkRow {
  id: string;
  title: string;
  author: string;
}
interface BiographyRow {
  id: string;
  biography_key: string;
  author_name: string;
  content_display: string;
  content_tts: { text?: string };
}
interface QuestionRow {
  id: string;
  question_key: string;
  max_points: number;
  display_md: string;
  narration: string;
  options: { id: string; display_md: string; narration: string }[];
}

export async function getLiteratureV3LessonView(familyId: string, lessonId: string): Promise<LiteratureV3LessonView | null> {
  const scope = forFamily(familyId);
  const { data: lesson } = await scope
    .select("literature_v3_lessons", "id, subject_id, topic_id, package_id, lesson_key, title, objectives, printed_page_from, printed_page_to, flow, status")
    .eq("id", lessonId)
    .maybeSingle<LessonRow>();
  if (!lesson) return null;

  const screenKeys = lesson.flow.filter((f) => f.kind === "screen").map((f) => f.ref_id);
  const readingKeys = lesson.flow.filter((f) => f.kind === "reading").map((f) => f.ref_id);
  const biographyKeys = lesson.flow.filter((f) => f.kind === "biography").map((f) => f.ref_id);
  const quizKeys = lesson.flow.filter((f) => f.kind === "quiz").map((f) => f.ref_id);

  const [{ data: pkg }, { data: screens }, { data: readingItems }, { data: biographies }, { data: questions }] = await Promise.all([
    scope.select("literature_v3_packages", "title").eq("id", lesson.package_id).maybeSingle<{ title: string }>(),
    screenKeys.length
      ? scope.select("literature_v3_screens", "id, screen_key, title, content_display, content_tts, asset_ids").eq("lesson_id", lessonId).in("screen_key", screenKeys).returns<ScreenRow[]>()
      : Promise.resolve({ data: [] as ScreenRow[] }),
    readingKeys.length
      ? scope.select("literature_v3_reading_items", "id, reading_key, title, content_display, content_tts, work_id, primary_page_id").in("reading_key", readingKeys).returns<ReadingItemRow[]>()
      : Promise.resolve({ data: [] as ReadingItemRow[] }),
    biographyKeys.length
      ? scope.select("literature_v3_biographies", "id, biography_key, author_name, content_display, content_tts").in("biography_key", biographyKeys).returns<BiographyRow[]>()
      : Promise.resolve({ data: [] as BiographyRow[] }),
    quizKeys.length
      ? scope.select("course_v2_questions", "id, question_key, max_points, display_md, narration, options").eq("literature_v3_lesson_id", lessonId).in("question_key", quizKeys).returns<QuestionRow[]>()
      : Promise.resolve({ data: [] as QuestionRow[] }),
  ]);

  const workIds = [...new Set((readingItems ?? []).map((r) => r.work_id))];
  const { data: works } = workIds.length ? await scope.select("literature_v3_works", "id, title, author").in("id", workIds).returns<WorkRow[]>() : { data: [] as WorkRow[] };
  const workById = new Map((works ?? []).map((w) => [w.id, w]));

  const primaryPageIds = [...new Set((readingItems ?? []).map((r) => r.primary_page_id).filter((id): id is string => !!id))];
  const { data: pageRows } = primaryPageIds.length
    ? await scope.select("literature_v3_pages", "page_key, printed_page").eq("package_id", lesson.package_id).in("page_key", primaryPageIds).returns<{ page_key: string; printed_page: number }[]>()
    : { data: [] as { page_key: string; printed_page: number }[] };
  const printedPageByPageKey = new Map((pageRows ?? []).map((p) => [p.page_key, p.printed_page]));

  // PO complaint 2026-10-16 ("чому в уроках не підтягуються ілюстрації?"):
  // `asset_ids` was always imported onto `literature_v3_screens` (see
  // `literatureV3Persist.ts`), but this read path never selected it nor
  // resolved the referenced `literature_v3_assets` rows into a URL — so the
  // illustrations the package's own screens reference ("Поруч показано...")
  // simply never reached the viewer. Same signed-URL pattern as
  // `literatureV2View.ts`'s `signPackageAssets`.
  const illustrationAssetIds = [...new Set((screens ?? []).flatMap((s) => s.asset_ids ?? []))];
  const { data: illustrationAssets } = illustrationAssetIds.length
    ? await scope.select("literature_v3_assets", "asset_key, storage_path, caption, alt").eq("package_id", lesson.package_id).in("asset_key", illustrationAssetIds).returns<IllustrationAssetRow[]>()
    : { data: [] as IllustrationAssetRow[] };
  const illustrationStoragePaths = (illustrationAssets ?? []).filter((a) => a.storage_path).map((a) => a.storage_path as string);
  const { data: signedIllustrations } = illustrationStoragePaths.length
    ? await scope.client.storage.from(LIT_V3_ASSETS_BUCKET).createSignedUrls(illustrationStoragePaths, SIGNED_URL_TTL_S)
    : { data: [] };
  const signedUrlByStoragePath = new Map((signedIllustrations ?? []).filter((s) => !s.error).map((s) => [s.path ?? "", s.signedUrl]));
  const illustrationByAssetKey = new Map(
    (illustrationAssets ?? []).map((a) => [
      a.asset_key,
      { assetKey: a.asset_key, url: a.storage_path ? (signedUrlByStoragePath.get(a.storage_path) ?? null) : null, caption: a.caption, alt: a.alt } satisfies LiteratureV3IllustrationView,
    ]),
  );

  const screenByKey = new Map((screens ?? []).map((s) => [s.screen_key, s]));
  const readingByKey = new Map((readingItems ?? []).map((r) => [r.reading_key, r]));
  const biographyByKey = new Map((biographies ?? []).map((b) => [b.biography_key, b]));
  const questionByKey = new Map((questions ?? []).map((q) => [q.question_key, q]));

  const flow: LiteratureV3FlowStep[] = [];
  for (const step of lesson.flow) {
    if (step.kind === "screen") {
      const s = screenByKey.get(step.ref_id);
      if (!s) continue;
      flow.push({
        kind: "screen",
        id: s.id,
        title: s.title,
        displayText: s.content_display,
        ttsText: s.content_tts?.text ?? s.content_display,
        illustrations: (s.asset_ids ?? []).map((id) => illustrationByAssetKey.get(id)).filter((a): a is LiteratureV3IllustrationView => a != null),
      });
    } else if (step.kind === "reading") {
      const r = readingByKey.get(step.ref_id);
      if (!r) continue;
      const work = workById.get(r.work_id);
      flow.push({
        kind: "reading",
        id: r.id,
        workTitle: work?.title ?? "",
        workAuthor: work?.author ?? "",
        title: r.title,
        displayText: r.content_display,
        ttsText: r.content_tts?.text ?? r.content_display,
        bookPage: r.primary_page_id ? (printedPageByPageKey.get(r.primary_page_id) ?? null) : null,
      });
    } else if (step.kind === "biography") {
      const b = biographyByKey.get(step.ref_id);
      if (!b) continue;
      flow.push({ kind: "biography", id: b.id, authorName: b.author_name, displayText: b.content_display, ttsText: b.content_tts?.text ?? b.content_display });
    } else if (step.kind === "quiz") {
      const q = questionByKey.get(step.ref_id);
      if (!q) continue;
      flow.push({
        kind: "quiz",
        id: step.ref_id,
        question: { id: q.id, displayMd: q.display_md, narration: q.narration, maxPoints: q.max_points, options: q.options.map((o) => ({ id: o.id, displayMd: o.display_md })) },
      });
    }
  }

  return {
    id: lesson.id,
    subjectId: lesson.subject_id,
    topicId: lesson.topic_id,
    packageId: lesson.package_id,
    packageTitle: pkg?.title ?? "",
    lessonKey: lesson.lesson_key,
    title: lesson.title,
    objectives: lesson.objectives ?? [],
    printedPageFrom: lesson.printed_page_from,
    printedPageTo: lesson.printed_page_to,
    flow,
    status: lesson.status,
  };
}

export interface LiteratureV3LessonListItem {
  id: string;
  orderNo: number;
  title: string;
  status: "active" | "needs_review";
}

export async function listLiteratureV3Lessons(familyId: string, packageId: string): Promise<LiteratureV3LessonListItem[]> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("literature_v3_lessons", "id, order_no, title, status")
    .eq("package_id", packageId)
    .order("order_no")
    .returns<{ id: string; order_no: number; title: string; status: "active" | "needs_review" }[]>();
  return (data ?? []).map((r) => ({ id: r.id, orderNo: r.order_no, title: r.title, status: r.status }));
}

export interface LiteratureV3BookPage {
  printedPage: number;
  assetId: string;
  bundlePdfPage: number;
}

/**
 * US-31.3 (ADR-044 §4) — the "virtual book" page index for one package: for
 * every printed page the pages.json reverse index knows, which `lesson_pdf`
 * asset (resolved to its DB uuid, not the package's own text id) and which
 * page INSIDE that small PDF holds it. Ordered by `printedPage` so
 * `VirtualBookReader` can step past one small PDF's own last page straight
 * into the next asset's first page without the child ever noticing two
 * different files are involved (see ADR-044 §4's "безшовність").
 *
 * A page with no resolvable lesson_pdf location (not every printed page
 * necessarily has one importable yet) is simply skipped — same resilience
 * stance as the rest of this read path (a step that doesn't resolve is
 * skipped, never shown broken).
 */
export async function getLiteratureV3BookIndex(familyId: string, packageId: string): Promise<LiteratureV3BookPage[]> {
  const scope = forFamily(familyId);
  const [{ data: pages }, { data: assets }] = await Promise.all([
    scope
      .select("literature_v3_pages", "printed_page, lesson_locations")
      .eq("package_id", packageId)
      .order("printed_page")
      .returns<{ printed_page: number; lesson_locations: { lesson_key: string; pdf_asset_key: string; bundle_pdf_page: number }[] }[]>(),
    scope.select("literature_v3_assets", "id, asset_key").eq("package_id", packageId).eq("kind", "lesson_pdf").returns<{ id: string; asset_key: string }[]>(),
  ]);
  const assetIdByKey = new Map((assets ?? []).map((a) => [a.asset_key, a.id]));

  const result: LiteratureV3BookPage[] = [];
  for (const page of pages ?? []) {
    const location = page.lesson_locations[0]; // first known location is enough for navigation purposes.
    if (!location) continue;
    const assetId = assetIdByKey.get(location.pdf_asset_key);
    if (!assetId) continue;
    result.push({ printedPage: page.printed_page, assetId, bundlePdfPage: location.bundle_pdf_page });
  }
  return result;
}

export interface LiteratureV3ReadingPosition {
  refId: string;
  offsetCodepoints: number;
}

/**
 * US-31.2 КП-2 — the child's saved reading position for one lesson, if any
 * (`literature_v3_reading_positions`, see migration
 * `20261024100000_s45b_literature_v3_reading_position.sql` for why this is a
 * small dedicated table rather than `lesson_sessions.reading_position`).
 * `null` when nothing was ever saved (most lessons, most of the time) — the
 * viewer then falls back to its existing "start at flow index 0" behaviour.
 */
export async function getLiteratureV3ReadingPosition(familyId: string, childProfileId: string, lessonId: string): Promise<LiteratureV3ReadingPosition | null> {
  const scope = forFamily(familyId);
  const { data } = await scope
    .select("literature_v3_reading_positions", "position")
    .eq("child_profile_id", childProfileId)
    .eq("lesson_id", lessonId)
    .maybeSingle<{ position: { ref_id: string; offset_codepoints: number } }>();
  if (!data) return null;
  return { refId: data.position.ref_id, offsetCodepoints: data.position.offset_codepoints };
}

/** Same role as `mathCourseV2View.ts`'s `getActiveMathCourseV2LessonIdForTopic` (see its doc comment). */
export async function getActiveLiteratureV3LessonIdForTopic(familyId: string, topicId: string): Promise<string | null> {
  const scope = forFamily(familyId);
  const { data } = await scope.select("literature_v3_lessons", "id").eq("topic_id", topicId).eq("status", "active").limit(1).maybeSingle<{ id: string }>();
  return data?.id ?? null;
}
