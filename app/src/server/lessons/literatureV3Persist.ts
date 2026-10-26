import { leadingParagraphNumber } from "@/lib/paragraph-order";
import "server-only";
import { createHash } from "node:crypto";
import type { FamilyScope } from "@/server/db/family-scope";
import type { ParsedAsset, ParsedLiteratureV3Package } from "./literatureV3Import";

/**
 * S45: persists an already-parsed+validated "Українська література"
 * v2.0.0 chapter-package (`literatureV3Import.ts`) — DB rows + Storage
 * uploads for illustrations and per-lesson PDFs. ZERO AI calls. Idempotent
 * re-import: every write is an upsert keyed on the package's own stable ids
 * (mirrors `mathCourseV2Persist.ts`/`literatureV2Persist.ts`'s conventions).
 *
 * Quizzes (`course.tasks`, `response_type: "single_choice"`) are persisted
 * into the EXISTING `course_v2_questions`/`course_v2_question_keys`/
 * `course_v2_quizzes`/`course_v2_quiz_items` tables (S35), via the new
 * `literature_v3_lesson_id` column — the SAME persistence pattern as
 * `mathCourseV2Persist.ts` uses for math questions, just a different parent
 * FK (ADR-044 §1). No new quiz tables.
 */

const LIT_V3_ASSETS_BUCKET = "course_assets"; // shared bucket (S34/S35/S36); v3-literature assets live under `lit-v3/{packageId}/...`.

/**
 * BUG follow-up (Алекс 2026-10-23, "знову бачу той самий баг... параграфи
 * розміщені не в нумерологічному порядку"): the 2026-10-16 fix below made
 * `sort_order` sequential WITHIN one import run, but two separate
 * import/re-import runs (e.g. a package updated or re-uploaded in parts)
 * each restart their own `lessonsImported` counter at 0 — so topics from
 * different runs can still interleave out of paragraph order. Every lesson
 * this package format actually ships has a title starting "§ N" or
 * "§ N-M" (a textbook paragraph/range number) — extracting that number and
 * using it as the sort key is stable across any number of import runs,
 * unlike a per-run counter. Falls back to the old counter only for a title
 * that doesn't start with "§" (keeps non-numbered packages unaffected).
 */

const RETRYABLE_ERROR_RE = /bad gateway|502|503|504|gateway timeout|network|fetch failed|ECONNRESET|ETIMEDOUT/i;

async function uploadAssetWithRetry(scope: FamilyScope, storagePath: string, bytes: Uint8Array, mimeType: string): Promise<{ error: { message: string } | null }> {
  const delays = [300, 1000, 3000];
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const { error } = await scope.client.storage.from(LIT_V3_ASSETS_BUCKET).upload(storagePath, bytes, { contentType: mimeType, upsert: true });
    if (!error) return { error: null };
    lastError = error;
    if (attempt === delays.length || !RETRYABLE_ERROR_RE.test(error.message)) break;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
  return { error: lastError };
}

export interface LiteratureV3PersistContext {
  subjectId: string;
}

export interface LiteratureV3PersistSummary {
  packageId: string;
  lessonsImported: number;
  screensImported: number;
  worksImported: number;
  readingItemsImported: number;
  biographiesImported: number;
  questionsImported: number;
  questionKeysImported: number;
  quizzesImported: number;
  quizItemsImported: number;
  pagesImported: number;
  assetsUploaded: number;
  assetsMissing: string[];
  assetUploadFailures: { path: string; message: string }[];
  /** A changed source descriptor could not replace the previously uploaded media. */
  assetReuseWarnings?: { path: string; message: string }[];
}

/**
 * Uploads every asset the package's `catalog/assets.json` lists (both
 * illustrations and `lesson_pdf`) that is present in `assetFiles` (keyed by
 * the package's own `path`, e.g. "assets/p022-dara-kornii.webp" or
 * "assets/lessons/L001.pdf"). `assetFiles` may be empty (the import action
 * accepts the JSON files without the binaries zip — the real package's
 * `lesson_pdf` binaries have not been sent yet as of this slice) — missing
 * assets are reported, never block the rest of the import (same resilience
 * as S34/S35/S36's `persistAssets`, 2026-10-02 incident).
 */
interface StoredAsset {
  asset_key: string;
  kind: ParsedAsset["kind"];
  storage_path: string | null;
  mime_type: string;
  byte_size: number | null;
  sha256: string | null;
  title: string;
  caption: string;
  alt: string;
  tts: ParsedAsset["tts"] | Record<string, never>;
  page_map: ParsedAsset["page_map"];
}

async function persistAssets(
  scope: FamilyScope,
  packageId: string,
  parsed: ParsedLiteratureV3Package,
  assetFiles: Map<string, Uint8Array>,
): Promise<{ uploaded: number; missing: string[]; uploadFailures: { path: string; message: string }[]; reuseWarnings: { path: string; message: string }[] }> {
  const missing: string[] = [];
  const uploadFailures: { path: string; message: string }[] = [];
  const reuseWarnings: { path: string; message: string }[] = [];
  let uploaded = 0;

  // An omitted or failed replacement must not disconnect an existing file.
  // Read only assets belonging to this family AND this package. Bounded key
  // batches avoid PostgREST's result limit dropping a retained asset silently.
  const previous = new Map<string, StoredAsset>();
  const keys = [...new Set(parsed.assets.map((asset) => asset.id))];
  for (let i = 0; i < keys.length; i += 100) {
    const { data, error } = await scope.select("literature_v3_assets", "asset_key,kind,storage_path,mime_type,byte_size,sha256,title,caption,alt,tts,page_map")
      .eq("package_id", packageId).in("asset_key", keys.slice(i, i + 100)).returns<StoredAsset[]>();
    if (error) throw new Error(`reading existing literature_v3_assets failed: ${error.message}`);
    for (const asset of data ?? []) previous.set(asset.asset_key, asset);
  }

  for (const asset of parsed.assets) {
    const old = previous.get(asset.id);
    const bytes = assetFiles.get(asset.path);
    let storedPath = old?.storage_path || null;
    let replaced = false;
    let uploadedHash: string | null = null;
    let uploadedByteSize: number | null = null;
    if (bytes) {
      // Keep replacements immutable until their DB pointer can be saved.
      // Failed uploads therefore cannot overwrite the previous media object.
      const digest = createHash("sha256").update(bytes).digest("hex");
      const storagePath = `lit-v3/${packageId}/${encodeURIComponent(asset.id)}/${digest}`;
      const { error: uploadErr } = await uploadAssetWithRetry(scope, storagePath, bytes, asset.mime_type);
      if (uploadErr) {
        uploadFailures.push({ path: asset.path, message: uploadErr.message });
      } else {
        storedPath = storagePath;
        replaced = true;
        uploadedHash = digest;
        uploadedByteSize = bytes.byteLength;
        uploaded += 1;
      }
    }
    if (!storedPath) missing.push(asset.path);

    const retained = !replaced && storedPath ? old : undefined;
    const sourceChanged = !!retained && (
      retained.kind !== asset.kind || retained.mime_type !== asset.mime_type ||
      (!!asset.sha256 && asset.sha256.toLowerCase() !== retained.sha256?.toLowerCase()) ||
      (asset.byte_size > 0 && asset.byte_size !== retained.byte_size) ||
      JSON.stringify(retained.page_map ?? []) !== JSON.stringify(asset.page_map)
    );
    if (sourceChanged) reuseWarnings.push({
      path: asset.path,
      message: "Новий опис файлу відрізняється від збереженого, але новий файл не завантажено. Залишено попередній файл і його метадані; завантажте відповідний архів, щоб оновити його.",
    });

    const { error: rowErr } = await scope.client
      .from("literature_v3_assets")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          asset_key: asset.id,
          kind: retained?.kind ?? asset.kind,
          storage_path: storedPath,
          // Retaining an old file must not relabel it as the requested new
          // bytes/type/hash, or attach a new PDF page map to older contents.
          mime_type: retained?.mime_type ?? asset.mime_type,
          title: sourceChanged ? retained!.title : (asset.title ?? ""),
          caption: sourceChanged ? retained!.caption : (asset.caption ?? ""),
          alt: sourceChanged ? retained!.alt : (asset.alt ?? ""),
          tts: sourceChanged ? retained!.tts : (asset.tts ?? {}),
          page_map: retained ? retained.page_map : asset.page_map,
          byte_size: replaced ? uploadedByteSize : retained ? retained.byte_size : (asset.byte_size ?? null),
          sha256: replaced ? uploadedHash : retained ? retained.sha256 : (asset.sha256 || null),
        },
        { onConflict: "package_id,asset_key" },
      );
    if (rowErr) throw new Error(`literature_v3_assets upsert failed for ${asset.id}: ${rowErr.message}`);
  }

  return { uploaded, missing, uploadFailures, reuseWarnings };
}

export async function persistLiteratureV3Package(
  scope: FamilyScope,
  ctx: LiteratureV3PersistContext,
  parsed: ParsedLiteratureV3Package,
  assetFiles: Map<string, Uint8Array> = new Map(),
): Promise<LiteratureV3PersistSummary> {
  if (!parsed.manifest) throw new Error("persistLiteratureV3Package: manifest is null — nothing to persist");
  const manifest = parsed.manifest;

  const { data: pkg, error: pkgErr } = await scope.client
    .from("literature_v3_packages")
    .upsert(
      {
        owner_family_id: scope.familyId,
        subject_id: ctx.subjectId,
        package_key: manifest.book_id,
        title: manifest.source_edition || manifest.book_id,
        progress_namespace: manifest.progress_namespace,
        counts: {
          lessons: parsed.lessons.length,
          works: parsed.works.length,
          readingItems: parsed.readingItems.length,
          biographies: parsed.biographies.length,
          tasks: parsed.tasks.length,
        },
        status: "active",
        last_import_errors: parsed.errors,
        last_import_warnings: parsed.warnings,
        imported_at: new Date().toISOString(),
      },
      { onConflict: "owner_family_id,package_key" },
    )
    .select("id")
    .single<{ id: string }>();
  if (pkgErr) throw new Error(`literature_v3_packages upsert failed: ${pkgErr.message}`);
  const packageId = pkg.id;

  const { uploaded, missing, uploadFailures, reuseWarnings } = await persistAssets(scope, packageId, parsed, assetFiles);

  // Page key -> printed_page, used to derive each lesson's printed_page_from/to.
  const printedPageByPageKey = new Map(parsed.pages.map((p) => [p.id, p.printed_page]));

  let pagesImported = 0;
  for (const page of parsed.pages) {
    const { error } = await scope.client
      .from("literature_v3_pages")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          page_key: page.id,
          printed_page: page.printed_page,
          source_pdf_page: page.source_pdf_page,
          lesson_locations: page.lesson_locations.map((loc) => ({ lesson_key: loc.lesson_id, pdf_asset_key: loc.pdf_asset_id, bundle_pdf_page: loc.bundle_pdf_page })),
        },
        { onConflict: "package_id,page_key" },
      );
    if (error) throw new Error(`literature_v3_pages upsert failed for ${page.id}: ${error.message}`);
    pagesImported += 1;
  }

  let worksImported = 0;
  const workIdByKey = new Map<string, string>();
  for (const work of parsed.works) {
    const { data: saved, error } = await scope.client
      .from("literature_v3_works")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          work_key: work.id,
          title: work.title,
          author: work.author,
          form: work.form,
          scope: work.scope,
          completeness: work.completeness,
          note: work.note,
        },
        { onConflict: "package_id,work_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`literature_v3_works upsert failed for ${work.id}: ${error.message}`);
    workIdByKey.set(work.id, saved.id);
    worksImported += 1;
  }

  let readingItemsImported = 0;
  const readingItemIdByKey = new Map<string, string>();
  for (const item of parsed.readingItems) {
    const workId = workIdByKey.get(item.work_id);
    if (!workId) continue; // cross-checked upstream; nothing more to do here.
    const { data: saved, error } = await scope.client
      .from("literature_v3_reading_items")
      .upsert(
        {
          owner_family_id: scope.familyId,
          work_id: workId,
          reading_key: item.id,
          sequence_no: item.sequence,
          title: item.title,
          content_type: item.content_type,
          content_display: item.content.display,
          content_tts: item.content.tts,
          primary_page_id: item.primary_page_id,
        },
        { onConflict: "work_id,reading_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`literature_v3_reading_items upsert failed for ${item.id}: ${error.message}`);
    readingItemIdByKey.set(item.id, saved.id);
    readingItemsImported += 1;
  }

  let biographiesImported = 0;
  const biographyIdByKey = new Map<string, string>();
  for (const bio of parsed.biographies) {
    const { data: saved, error } = await scope.client
      .from("literature_v3_biographies")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          biography_key: bio.id,
          author_name: bio.author_name,
          origin: bio.origin,
          content_display: bio.content.display,
          content_tts: bio.content.tts,
        },
        { onConflict: "package_id,biography_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`literature_v3_biographies upsert failed for ${bio.id}: ${error.message}`);
    biographyIdByKey.set(bio.id, saved.id);
    biographiesImported += 1;
  }

  let lessonsImported = 0;
  const lessonIdByKey = new Map<string, string>();
  for (const lesson of parsed.lessons) {
    const { data: existing } = await scope.client
      .from("literature_v3_lessons")
      .select("id, topic_id")
      .eq("package_id", packageId)
      .eq("lesson_key", lesson.id)
      .maybeSingle<{ id: string; topic_id: string | null }>();

    const printedPages = lesson.source_pages.map((p) => printedPageByPageKey.get(p)).filter((p): p is number => typeof p === "number");
    const printedPageFrom = printedPages.length ? Math.min(...printedPages) : null;
    const printedPageTo = printedPages.length ? Math.max(...printedPages) : null;

    let topicId = existing?.topic_id ?? null;
    // BUG (Алекс 2026-10-16, "в списку уроків історії відсутнє сортування"):
    // this used to insert `sort_order: lesson.flow.length` — the STEP COUNT
    // of this one lesson, not its position among the package's lessons —
    // so the subject's topic list sorted by "how many screens/readings/
    // quizzes this lesson happens to have," not lesson order. Must be the
    // same sequential counter `order_no` uses below (`lessonsImported`),
    // same convention as `literatureV2Persist.ts`'s `sort_order: index` /
    // `mathCourseV2Persist.ts`'s `sort_order: lesson.order`. Also now part
    // of `topicFields` so a RE-IMPORT (the `else` update branch) fixes a
    // topic's stale sort_order too, not just a fresh insert.
    const topicFields = {
      title: lesson.title,
      page_from: printedPageFrom,
      page_to: printedPageTo,
      grade: lesson.grade,
      sort_order: leadingParagraphNumber(lesson.title) ?? lessonsImported,
    };
    if (!topicId) {
      const { data: topicRow, error: topicErr } = await scope.client
        .from("topics")
        .insert({ owner_family_id: scope.familyId, subject_id: ctx.subjectId, ...topicFields })
        .select("id")
        .single<{ id: string }>();
      if (topicErr) throw new Error(`topics insert failed for ${lesson.id}: ${topicErr.message}`);
      topicId = topicRow.id;
    } else {
      await scope.client.from("topics").update(topicFields).eq("id", topicId);
    }

    const { data: saved, error: lessonErr } = await scope.client
      .from("literature_v3_lessons")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          subject_id: ctx.subjectId,
          topic_id: topicId,
          lesson_key: lesson.id,
          order_no: lessonsImported,
          title: lesson.title,
          estimated_minutes: lesson.estimated_minutes || null,
          objectives: lesson.objectives,
          prerequisites: lesson.prerequisites,
          misconceptions: lesson.misconceptions,
          explanation: lesson.explanation,
          definitions: lesson.definitions,
          worked_example: lesson.worked_example,
          flow: lesson.flow,
          page_bundle_asset_id: lesson.page_bundle_asset_id,
          printed_page_from: printedPageFrom,
          printed_page_to: printedPageTo,
          content_status: lesson.content_status,
          status: "active",
        },
        { onConflict: "package_id,lesson_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (lessonErr) throw new Error(`literature_v3_lessons upsert failed for ${lesson.id}: ${lessonErr.message}`);
    lessonIdByKey.set(lesson.id, saved.id);
    lessonsImported += 1;
  }

  let screensImported = 0;
  for (const lesson of parsed.lessons) {
    const lessonId = lessonIdByKey.get(lesson.id);
    if (!lessonId) continue;
    for (let i = 0; i < lesson.screens.length; i++) {
      const screen = lesson.screens[i]!;
      const { error } = await scope.client
        .from("literature_v3_screens")
        .upsert(
          {
            owner_family_id: scope.familyId,
            lesson_id: lessonId,
            screen_key: screen.id,
            order_no: i,
            step_type: screen.step_type,
            title: screen.title,
            content_display: screen.content.display,
            content_tts: screen.content.tts,
            tutor_action: screen.tutor_action,
            asset_ids: screen.asset_ids,
          },
          { onConflict: "lesson_id,screen_key" },
        );
      if (error) throw new Error(`literature_v3_screens upsert failed for ${screen.id}: ${error.message}`);
      screensImported += 1;
    }
  }

  // Quizzes — literal reuse of course_v2_questions/course_v2_quizzes/
  // course_v2_quiz_items/course_v2_question_keys (ADR-044 §1). One
  // course_v2_quizzes row per lesson that has at least one `quiz` step.
  let questionsImported = 0;
  let questionKeysImported = 0;
  let quizzesImported = 0;
  let quizItemsImported = 0;
  const questionIdByKey = new Map<string, string>();
  const taskKeyByTaskId = new Map(parsed.taskKeys.map((k) => [k.task_id, k]));

  for (const lesson of parsed.lessons) {
    const lessonId = lessonIdByKey.get(lesson.id);
    if (!lessonId) continue;
    const quizTaskIds = lesson.flow.filter((f) => f.kind === "quiz").map((f) => f.ref_id);
    if (quizTaskIds.length === 0) continue;

    const { data: savedQuiz, error: quizErr } = await scope.client
      .from("course_v2_quizzes")
      .upsert(
        {
          owner_family_id: scope.familyId,
          literature_v3_lesson_id: lessonId,
          quiz_key: `${lesson.id}-quiz`,
          title: "",
          question_count: quizTaskIds.length,
          max_points: quizTaskIds.length,
          mastery_threshold: 0.8,
          scoring: "",
        },
        { onConflict: "literature_v3_lesson_id,quiz_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (quizErr) throw new Error(`course_v2_quizzes upsert failed for ${lesson.id}: ${quizErr.message}`);
    quizzesImported += 1;

    for (let i = 0; i < quizTaskIds.length; i++) {
      const task = parsed.tasks.find((t) => t.id === quizTaskIds[i]);
      if (!task) continue; // cross-checked upstream (flow ref integrity); nothing more to do here.

      const { data: savedQuestion, error: qErr } = await scope.client
        .from("course_v2_questions")
        .upsert(
          {
            owner_family_id: scope.familyId,
            literature_v3_lesson_id: lessonId,
            question_key: task.id,
            max_points: 1,
            display_md: task.prompt.display,
            narration: task.prompt.tts.text,
            options: task.options.map((o) => ({ id: o.id, display_md: o.content.display, narration: o.content.tts.text })),
          },
          { onConflict: "literature_v3_lesson_id,question_key" },
        )
        .select("id")
        .single<{ id: string }>();
      if (qErr) throw new Error(`course_v2_questions upsert failed for ${task.id}: ${qErr.message}`);
      questionIdByKey.set(task.id, savedQuestion.id);
      questionsImported += 1;

      const { error: itemErr } = await scope.client
        .from("course_v2_quiz_items")
        .upsert(
          { owner_family_id: scope.familyId, quiz_id: savedQuiz.id, question_id: savedQuestion.id, order_no: i, max_points: 1 },
          { onConflict: "quiz_id,question_id" },
        );
      if (itemErr) throw new Error(`course_v2_quiz_items upsert failed for ${task.id}: ${itemErr.message}`);
      quizItemsImported += 1;

      const key = taskKeyByTaskId.get(task.id);
      if (!key) continue; // cross-checked upstream (every task should have a key, reported as a warning if not).
      const { error: keyErr } = await scope.client
        .from("course_v2_question_keys")
        .upsert(
          {
            owner_family_id: scope.familyId,
            question_id: savedQuestion.id,
            correct_option_id: key.correct_option_ids[0]!,
            hint: key.hints[0]?.display ?? "",
            hint_narration: key.hints[0]?.tts.text ?? "",
            explanation_md: key.explanation.display,
            explanation_narration: key.explanation.tts.text,
            option_feedback: key.option_feedback.map((f) => ({ id: f.option_id, feedback: f.content.display, feedback_narration: f.content.tts.text })),
            equations_latex: [],
            certificate: {},
          },
          { onConflict: "question_id" },
        );
      if (keyErr) throw new Error(`course_v2_question_keys upsert failed for ${task.id}: ${keyErr.message}`);
      questionKeysImported += 1;
    }
  }

  return {
    packageId,
    lessonsImported,
    screensImported,
    worksImported,
    readingItemsImported,
    biographiesImported,
    questionsImported,
    questionKeysImported,
    quizzesImported,
    quizItemsImported,
    pagesImported,
    assetsUploaded: uploaded,
    assetsMissing: missing,
    assetUploadFailures: uploadFailures,
    assetReuseWarnings: reuseWarnings,
  };
}
