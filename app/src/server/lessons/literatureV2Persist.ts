import "server-only";
import type { FamilyScope } from "@/server/db/family-scope";
import type { ParsedLiteratureV2Package } from "./literatureV2Import";

/**
 * S36: persists an already-parsed+validated foreign-literature course
 * package v2 (`literatureV2Import.ts`) — DB rows + Storage uploads for the
 * illustrations. ZERO AI calls. Idempotent re-import: every write is an
 * upsert keyed on the package's own stable ids (mirrors
 * `mathCourseV2Persist.ts`'s S35 conventions closely).
 */

const COURSE_ASSETS_BUCKET = "course_assets"; // shared with S34/S35 (see those migrations); v2-literature assets live under `lit-v2/{packageId}/...`.
const RETRYABLE_ERROR_RE = /bad gateway|502|503|504|gateway timeout|network|fetch failed|ECONNRESET|ETIMEDOUT/i;

async function uploadAssetWithRetry(scope: FamilyScope, storagePath: string, bytes: Uint8Array, mimeType: string): Promise<{ error: { message: string } | null }> {
  const delays = [300, 1000, 3000];
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const { error } = await scope.client.storage.from(COURSE_ASSETS_BUCKET).upload(storagePath, bytes, { contentType: mimeType, upsert: true });
    if (!error) return { error: null };
    lastError = error;
    if (attempt === delays.length || !RETRYABLE_ERROR_RE.test(error.message)) break;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
  return { error: lastError };
}

export interface LiteratureV2PersistContext {
  subjectId: string;
}

export interface LiteratureV2PersistSummary {
  packageId: string;
  lessonsImported: number;
  screensImported: number;
  tasksImported: number;
  taskKeysImported: number;
  taskTablesImported: number;
  assetsUploaded: number;
  assetsMissing: string[];
  assetUploadFailures: { path: string; message: string }[];
}

async function persistAssets(
  scope: FamilyScope,
  packageId: string,
  parsed: ParsedLiteratureV2Package,
  assetFiles: Map<string, Uint8Array>,
): Promise<{ uploaded: number; missing: string[]; uploadFailures: { path: string; message: string }[] }> {
  const missing: string[] = [];
  const uploadFailures: { path: string; message: string }[] = [];
  let uploaded = 0;

  for (const asset of parsed.assets) {
    const bytes = assetFiles.get(asset.path);
    const storagePath = `lit-v2/${packageId}/${asset.id}`;
    let uploadedThisAsset = false;
    if (bytes) {
      const { error: uploadErr } = await uploadAssetWithRetry(scope, storagePath, bytes, asset.path.endsWith(".png") ? "image/png" : "image/jpeg");
      if (uploadErr) uploadFailures.push({ path: asset.path, message: uploadErr.message });
      else uploadedThisAsset = true;
    } else {
      missing.push(asset.path);
    }

    const { error: rowErr } = await scope.client
      .from("literature_v2_assets")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          asset_key: asset.id,
          page_id: asset.page_id,
          storage_path: uploadedThisAsset ? storagePath : null,
          mime_type: asset.path.endsWith(".png") ? "image/png" : "image/jpeg",
          caption: asset.caption,
          alt: asset.alt,
          tts: asset.tts ?? {},
          discussion_prompt: asset.discussion_prompt ?? {},
          printed_page: asset.source.printed_page,
          pdf_page: asset.source.pdf_page,
          bbox_pdf_points: asset.source.bbox_pdf_points,
          rights: asset.rights,
          sha256: asset.sha256,
        },
        { onConflict: "package_id,asset_key" },
      );
    if (rowErr) throw new Error(`literature_v2_assets upsert failed for ${asset.id}: ${rowErr.message}`);
    if (uploadedThisAsset) uploaded += 1;
  }

  return { uploaded, missing, uploadFailures };
}

export async function persistLiteratureV2Package(
  scope: FamilyScope,
  ctx: LiteratureV2PersistContext,
  parsed: ParsedLiteratureV2Package,
  assetFiles: Map<string, Uint8Array> = new Map(),
): Promise<LiteratureV2PersistSummary> {
  if (!parsed.bookId) throw new Error("persistLiteratureV2Package: bookId is null — nothing to persist");

  const title = parsed.lessons[0]?.title ? `Зарубіжна література (${parsed.bookId})` : parsed.bookId;
  const grade = parsed.lessons[0]?.grade ?? null;
  const { data: pkg, error: pkgErr } = await scope.client
    .from("literature_v2_packages")
    .upsert(
      {
        owner_family_id: scope.familyId,
        subject_id: ctx.subjectId,
        package_key: parsed.bookId,
        title,
        grade,
        counts: { lessons: parsed.lessons.length, tasks: parsed.tasks.length, assets: parsed.assets.length },
        status: "active",
        last_import_errors: parsed.errors,
        last_import_warnings: parsed.warnings,
        imported_at: new Date().toISOString(),
      },
      { onConflict: "owner_family_id,package_key" },
    )
    .select("id")
    .single<{ id: string }>();
  if (pkgErr) throw new Error(`literature_v2_packages upsert failed: ${pkgErr.message}`);
  const packageId = pkg.id;

  const { uploaded, missing, uploadFailures } = await persistAssets(scope, packageId, parsed, assetFiles);

  // Computed up front, service-role side, so the child-facing view
  // (`literatureV2View.ts`) never needs to read the locked
  // `literature_v2_task_keys` table itself — see that column's own comment.
  const taskIdsWithKey = new Set(parsed.taskKeys.map((k) => k.task_id));

  let lessonsImported = 0;
  const lessonIdByKey = new Map<string, string>();
  for (const [index, lesson] of parsed.lessons.entries()) {
    const { data: existing } = await scope.client
      .from("literature_v2_lessons")
      .select("id, topic_id")
      .eq("package_id", packageId)
      .eq("lesson_key", lesson.id)
      .maybeSingle<{ id: string; topic_id: string | null }>();

    const pages = lesson.primary_reading_pages.length > 0 ? lesson.primary_reading_pages : lesson.source_pages;
    // Pages are ids like "...-P004" — the printed/pdf page NUMBER itself
    // isn't on the lesson row in this package (only on individual tasks'
    // `source`), so topic page_from/page_to stay null here; the subject
    // screen already falls back gracefully when they're absent.
    let topicId = existing?.topic_id ?? null;
    const topicFields = { title: lesson.title, sort_order: index, grade: lesson.grade };
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

    const pageNumbers = parsed.tasks.filter((t) => t.lesson_id === lesson.id && t.source.printed_page != null).map((t) => t.source.printed_page as number);
    const printedPageFrom = pageNumbers.length ? Math.min(...pageNumbers) : null;
    const printedPageTo = pageNumbers.length ? Math.max(...pageNumbers) : null;

    const { data: savedLesson, error: lessonErr } = await scope.client
      .from("literature_v2_lessons")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          subject_id: ctx.subjectId,
          topic_id: topicId,
          lesson_key: lesson.id,
          order_no: index,
          title: lesson.title,
          estimated_minutes: lesson.estimated_minutes ?? null,
          objectives: lesson.objectives,
          prerequisites: lesson.prerequisites,
          explanation: lesson.explanation,
          definitions: lesson.definitions,
          worked_example: lesson.worked_example,
          misconceptions: lesson.misconceptions,
          task_ids: lesson.task_ids,
          practice_task_ids: lesson.practice_task_ids,
          final_check_task_ids: lesson.final_check_task_ids,
          primary_reading_pages: pages,
          illustration_ids: lesson.illustration_ids,
          printed_page_from: printedPageFrom,
          printed_page_to: printedPageTo,
          content_status: lesson.content_status,
          status: "active",
        },
        { onConflict: "package_id,lesson_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (lessonErr) throw new Error(`literature_v2_lessons upsert failed for ${lesson.id}: ${lessonErr.message}`);
    lessonIdByKey.set(lesson.id, savedLesson.id);
    lessonsImported += 1;

    for (const [screenIndex, screen] of lesson.screens.entries()) {
      const { error } = await scope.client
        .from("literature_v2_screens")
        .upsert(
          {
            owner_family_id: scope.familyId,
            lesson_id: savedLesson.id,
            screen_key: screen.id,
            order_no: screenIndex,
            step_type: screen.step_type,
            content_display: screen.content.display,
            content_tts: screen.content.tts,
            tutor_action: screen.tutor_action,
            asset_ids: screen.asset_ids,
          },
          { onConflict: "lesson_id,screen_key" },
        );
      if (error) throw new Error(`literature_v2_screens upsert failed for ${screen.id}: ${error.message}`);
    }
  }

  const screensImportedTotal = parsed.lessons.reduce((sum, lesson) => sum + lesson.screens.length, 0);

  let tasksImported = 0;
  const taskIdByKey = new Map<string, string>();
  for (const task of parsed.tasks) {
    const lessonId = lessonIdByKey.get(task.lesson_id);
    if (!lessonId) continue; // reported as a warning upstream (cross-check), nothing more to do here.
    const { data: saved, error } = await scope.client
      .from("literature_v2_tasks")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          lesson_id: lessonId,
          task_key: task.id,
          original_label: task.original_label,
          prompt_display: task.prompt.display,
          prompt_tts: task.prompt.tts,
          subtasks: task.subtasks.map((s) => ({ id: s.id, label: s.label, display: s.prompt.display, tts: s.prompt.tts })),
          response_type: task.response_type,
          source: task.source,
          asset_refs: task.asset_refs,
          required_inputs: task.required_inputs,
          printed_page: task.source.printed_page,
          pdf_page: task.source.pdf_page,
          has_hint: taskIdsWithKey.has(task.id),
          status: "active",
        },
        { onConflict: "package_id,task_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`literature_v2_tasks upsert failed for ${task.id}: ${error.message}`);
    taskIdByKey.set(task.id, saved.id);
    tasksImported += 1;
  }

  let taskKeysImported = 0;
  for (const key of parsed.taskKeys) {
    const taskId = taskIdByKey.get(key.task_id);
    if (!taskId) continue;
    const { error } = await scope.client
      .from("literature_v2_task_keys")
      .upsert(
        {
          owner_family_id: scope.familyId,
          task_id: taskId,
          hints: key.hints,
          solution_steps: key.solution_steps,
          answer: key.answer ?? {},
          answer_kind: key.answer_kind,
          criteria: key.criteria,
          acceptable_alternatives: key.acceptable_alternatives,
          misconceptions: key.misconceptions,
        },
        { onConflict: "task_id" },
      );
    if (error) throw new Error(`literature_v2_task_keys upsert failed for ${key.task_id}: ${error.message}`);
    taskKeysImported += 1;
  }

  let taskTablesImported = 0;
  for (const table of parsed.taskTables) {
    const taskId = taskIdByKey.get(table.task_id);
    if (!taskId) continue;
    const { error } = await scope.client
      .from("literature_v2_task_tables")
      .upsert(
        {
          owner_family_id: scope.familyId,
          task_id: taskId,
          table_key: table.id,
          columns: table.columns,
          rows: table.rows,
          source_pages: table.source_pages,
          empty_cells_are_student_input: table.empty_cells_are_student_input,
          origin: table.origin,
        },
        { onConflict: "task_id" },
      );
    if (error) throw new Error(`literature_v2_task_tables upsert failed for ${table.id}: ${error.message}`);
    taskTablesImported += 1;
  }

  return {
    packageId,
    lessonsImported,
    screensImported: screensImportedTotal,
    tasksImported,
    taskKeysImported,
    taskTablesImported,
    assetsUploaded: uploaded,
    assetsMissing: missing,
    assetUploadFailures: uploadFailures,
  };
}
