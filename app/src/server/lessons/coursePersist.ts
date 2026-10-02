import "server-only";
import type { FamilyScope } from "@/server/db/family-scope";
import type { ParsedAssetIndexEntry, ParsedCoursePackage, ParsedSourceImageBlock } from "./courseImport";

/**
 * S34: persists an already-parsed course package (`courseImport.ts`) — DB
 * rows + Supabase Storage uploads. ZERO AI calls (see migration header).
 * Idempotent re-import: every write is an upsert keyed on the package's own
 * stable ids (`package_key`, `lesson_key`, `exercise_key`, `asset_id`), same
 * pattern as `literatureExtraction.ts`'s `persistLiteratureTopic` — re-
 * uploading the same zip updates rows/files in place rather than
 * duplicating them.
 */

const COURSE_ASSETS_BUCKET = "course_assets";

export interface CoursePersistContext {
  subjectId: string;
  grade: number | null;
}

export interface CoursePersistSummary {
  packageId: string;
  lessonsImported: number;
  lessonsSkipped: number;
  lessonsNeedingReview: number;
  testsImported: number;
  exercisesImported: number;
  assetsUploaded: number;
  assetsMissingFromZip: string[];
}

/** Every asset path a lesson/exercise references (source_material, full_page_image_paths, exercise content, figure_paths) — the only files actually worth uploading. */
function collectReferencedAssetPaths(parsed: ParsedCoursePackage): Set<string> {
  const paths = new Set<string>();
  const addBlock = (b: ParsedSourceImageBlock) => {
    paths.add(b.path);
    if (b.pageImagePath) paths.add(b.pageImagePath);
  };
  for (const lesson of parsed.lessons) {
    lesson.sourceMaterial.forEach(addBlock);
    lesson.fullPageImagePaths.forEach((p) => paths.add(p));
  }
  for (const exercise of parsed.exercises) {
    exercise.content.forEach(addBlock);
    exercise.figurePaths.forEach((p) => paths.add(p));
  }
  return paths;
}

function assetIdFor(path: string, index: ParsedAssetIndexEntry | undefined): string {
  if (index) return index.id;
  // Fall back to the file's own basename (without extension) — stable across
  // re-imports as long as the package's own file naming is stable.
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function mimeTypeFor(path: string): string {
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

/**
 * Uploads every referenced-and-present asset to the `course_assets` bucket
 * and upserts its `course_package_assets` row. Returns the referenced paths
 * that were NOT found among the zip's `assets/*` files — reported to the
 * parent, never silently skipped (PO: no more silent failures).
 */
async function persistAssets(scope: FamilyScope, packageId: string, parsed: ParsedCoursePackage): Promise<{ uploaded: number; missing: string[] }> {
  const referenced = collectReferencedAssetPaths(parsed);
  const missing: string[] = [];
  let uploaded = 0;

  // Reverse-index assets/index.json entries by path (when present) so a
  // referenced path can pick up its physical/scale metadata.
  const indexByPath = new Map<string, ParsedAssetIndexEntry>();
  for (const entry of parsed.assetIndex.values()) indexByPath.set(entry.path, entry);

  for (const path of referenced) {
    const bytes = parsed.assetFiles.get(path);
    if (!bytes) {
      missing.push(path);
      continue;
    }
    const indexEntry = indexByPath.get(path);
    const assetId = assetIdFor(path, indexEntry);
    const storagePath = `${packageId}/${path}`;
    const mimeType = indexEntry?.mimeType ?? mimeTypeFor(path);

    const { error: uploadErr } = await scope.client.storage.from(COURSE_ASSETS_BUCKET).upload(storagePath, bytes, {
      contentType: mimeType,
      upsert: true,
    });
    if (uploadErr) throw new Error(`course_assets upload failed for ${path}: ${uploadErr.message}`);

    const { error: rowErr } = await scope.client
      .from("course_package_assets")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          asset_id: assetId,
          source_path: path,
          storage_path: storagePath,
          mime_type: mimeType,
          alt: indexEntry?.alt ?? null,
          printed_page: indexEntry?.printedPage ?? null,
          pdf_page: indexEntry?.pdfPage ?? null,
          bbox_pt: indexEntry?.bboxPt ?? null,
          width_px: indexEntry?.widthPx ?? null,
          height_px: indexEntry?.heightPx ?? null,
          physical_width_mm: indexEntry?.physicalWidthMm ?? null,
          physical_height_mm: indexEntry?.physicalHeightMm ?? null,
          scale_px_per_pdf_point: indexEntry?.scalePxPerPdfPoint ?? null,
        },
        { onConflict: "package_id,asset_id" },
      );
    if (rowErr) throw new Error(`course_package_assets upsert failed for ${path}: ${rowErr.message}`);
    uploaded += 1;
  }

  return { uploaded, missing };
}

export async function persistCoursePackage(
  scope: FamilyScope,
  ctx: CoursePersistContext,
  parsed: ParsedCoursePackage,
): Promise<CoursePersistSummary> {
  if (!parsed.manifest) throw new Error("persistCoursePackage: manifest is null — nothing to persist");
  const manifest = parsed.manifest;

  const { data: pkg, error: pkgErr } = await scope.client
    .from("course_packages")
    .upsert(
      {
        owner_family_id: scope.familyId,
        subject_id: ctx.subjectId,
        package_key: manifest.id,
        schema_version: manifest.schemaVersion,
        title: manifest.title,
        language: manifest.language,
        source_file: manifest.sourceFile,
        source_sha256: manifest.sourceSha256,
        grade: ctx.grade,
        counts: manifest.counts,
        quality_notes: manifest.qualityNotes,
        status: "active",
        last_import_errors: parsed.errors,
        last_import_warnings: parsed.warnings,
        imported_at: new Date().toISOString(),
      },
      { onConflict: "owner_family_id,package_key" },
    )
    .select("id")
    .single<{ id: string }>();
  if (pkgErr) throw new Error(`course_packages upsert failed: ${pkgErr.message}`);
  const packageId = pkg.id;

  const { uploaded, missing } = await persistAssets(scope, packageId, parsed);

  let lessonsImported = 0;
  let lessonsNeedingReview = 0;
  let testsImported = 0;

  for (const [order, lesson] of parsed.lessons.entries()) {
    const { data: existing } = await scope.client
      .from("course_lessons")
      .select("id, topic_id")
      .eq("package_id", packageId)
      .eq("lesson_key", lesson.lessonKey)
      .maybeSingle<{ id: string; topic_id: string | null }>();

    let topicId = existing?.topic_id ?? null;
    const topicFields = {
      title: lesson.title,
      page_from: lesson.source.printedPages[0] ?? null,
      page_to: lesson.source.printedPages[lesson.source.printedPages.length - 1] ?? null,
      sort_order: lesson.order,
      grade: lesson.grade ?? ctx.grade,
    };
    if (!topicId) {
      const { data: topicRow, error: topicErr } = await scope.client
        .from("topics")
        .insert({ owner_family_id: scope.familyId, subject_id: ctx.subjectId, ...topicFields })
        .select("id")
        .single<{ id: string }>();
      if (topicErr) throw new Error(`topics insert failed for ${lesson.lessonKey}: ${topicErr.message}`);
      topicId = topicRow.id;
    } else {
      await scope.client.from("topics").update(topicFields).eq("id", topicId);
    }

    const status: "active" | "needs_review" = lesson.needsReview ? "needs_review" : "active";
    if (status === "needs_review") lessonsNeedingReview += 1;

    const { data: savedLesson, error: lessonErr } = await scope.client
      .from("course_lessons")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          subject_id: ctx.subjectId,
          topic_id: topicId,
          lesson_key: lesson.lessonKey,
          order_no: lesson.order,
          kind: lesson.kind,
          title: lesson.title,
          grade: lesson.grade ?? ctx.grade,
          part: lesson.part,
          source: lesson.source,
          teacher_notes_md: lesson.teacherNotesMd,
          teacher_notes_origin: lesson.teacherNotesOrigin,
          source_material: lesson.sourceMaterial,
          exercise_ids: lesson.exerciseIds,
          exercise_count: lesson.exerciseCount,
          full_page_image_paths: lesson.fullPageImagePaths,
          source_text_policy: lesson.sourceTextPolicy,
          status,
          sort_order: order,
        },
        { onConflict: "package_id,lesson_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (lessonErr) throw new Error(`course_lessons upsert failed for ${lesson.lessonKey}: ${lessonErr.message}`);
    lessonsImported += 1;

    const test = parsed.testsByLessonKey.get(lesson.lessonKey);
    if (test) {
      const { error: testErr } = await scope.client
        .from("course_lesson_tests")
        .upsert(
          {
            owner_family_id: scope.familyId,
            lesson_id: savedLesson.id,
            test_key: test.testKey,
            title: test.title,
            automatic_questions: test.automaticQuestions,
            automatic_max_points: test.automaticMaxPoints,
            source_exercise_ids: test.sourceExerciseIds,
            source_keys_resource: test.sourceKeysResource,
            grading_policy: test.gradingPolicy,
          },
          { onConflict: "lesson_id" },
        );
      if (testErr) throw new Error(`course_lesson_tests upsert failed for ${lesson.lessonKey}: ${testErr.message}`);
      testsImported += 1;
    }
  }

  const lessonIdByKey = new Map<string, string>();
  {
    const { data: rows } = await scope.client.from("course_lessons").select("id, lesson_key").eq("package_id", packageId).returns<{ id: string; lesson_key: string }[]>();
    for (const row of rows ?? []) lessonIdByKey.set(row.lesson_key, row.id);
  }

  let exercisesImported = 0;
  for (const exercise of parsed.exercises) {
    const lessonId = lessonIdByKey.get(exercise.lessonKey) ?? null;
    const { error } = await scope.client
      .from("course_exercises")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          lesson_id: lessonId,
          exercise_key: exercise.exerciseKey,
          origin: exercise.origin,
          original_number: exercise.originalNumber,
          source: exercise.source,
          content: exercise.content,
          figure_ids: exercise.figureIds,
          figure_paths: exercise.figurePaths,
          search_text_ocr: exercise.searchTextOcr,
          text_status: exercise.textStatus,
          response_type: exercise.responseType,
          grading: exercise.grading,
          measurement_warning: exercise.measurementWarning,
        },
        { onConflict: "package_id,exercise_key" },
      );
    if (error) throw new Error(`course_exercises upsert failed for ${exercise.exerciseKey}: ${error.message}`);
    exercisesImported += 1;
  }

  return {
    packageId,
    lessonsImported,
    lessonsSkipped: parsed.errors.filter((e) => e.file?.startsWith("lessons/")).length,
    lessonsNeedingReview,
    testsImported,
    exercisesImported,
    assetsUploaded: uploaded,
    assetsMissingFromZip: missing,
  };
}
