import "server-only";
import type { FamilyScope } from "@/server/db/family-scope";
import { isConstructionTemplateAsset, type ParsedMathCourseV2Package } from "./mathCourseV2Import";

/**
 * S35: persists an already-parsed+validated math course-package v2
 * (`mathCourseV2Import.ts`) — DB rows + Storage uploads for the 35 figures.
 * ZERO AI calls. Idempotent re-import: every write is an upsert keyed on
 * the package's own stable ids (mirrors `coursePersist.ts`'s S34
 * conventions closely).
 */

const COURSE_ASSETS_BUCKET = "course_assets"; // shared with S34 (see migration header); v2 assets live under `v2/{packageId}/...`.
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

export interface MathCourseV2PersistContext {
  subjectId: string;
}

export interface MathCourseV2PersistSummary {
  packageId: string;
  lessonsImported: number;
  screensImported: number;
  questionsImported: number;
  questionKeysImported: number;
  quizzesImported: number;
  quizItemsImported: number;
  exercisesImported: number;
  exerciseSolutionsImported: number;
  sourceIssuesImported: number;
  assetsUploaded: number;
  assetsMissing: string[];
  assetUploadFailures: { path: string; message: string }[];
}

/**
 * Uploads every asset the package's `course.assets` lists and present in
 * `assetFiles` (keyed by the package's own `path`, e.g.
 * "assets/figures/figure_03.webp"). `assetFiles` may be empty (the import
 * action accepts the two JSON files without the figures zip) — missing
 * assets are reported, never block the rest of the import (same
 * resilience as S34's `persistAssets`, 2026-10-02 incident).
 */
async function persistAssets(
  scope: FamilyScope,
  packageId: string,
  parsed: ParsedMathCourseV2Package,
  assetFiles: Map<string, Uint8Array>,
): Promise<{ uploaded: number; missing: string[]; uploadFailures: { path: string; message: string }[] }> {
  const missing: string[] = [];
  const uploadFailures: { path: string; message: string }[] = [];
  let uploaded = 0;

  for (const asset of parsed.assets) {
    const bytes = assetFiles.get(asset.path);
    if (!bytes) {
      missing.push(asset.path);
      continue;
    }
    const storagePath = `v2/${packageId}/${asset.id}`;
    const { error: uploadErr } = await uploadAssetWithRetry(scope, storagePath, bytes, asset.mime_type);
    if (uploadErr) {
      uploadFailures.push({ path: asset.path, message: uploadErr.message });
      continue;
    }
    const { error: rowErr } = await scope.client
      .from("course_v2_assets")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          asset_key: asset.id,
          storage_path: storagePath,
          mime_type: asset.mime_type,
          alt: asset.alt,
          printed_page: asset.source.printed_page,
          pdf_page: asset.source.pdf_page,
          width_px: asset.width_px,
          height_px: asset.height_px,
          physical_width_mm: asset.physical_width_mm,
          physical_height_mm: asset.physical_height_mm,
          scale_px_per_pdf_point: asset.scale_pixels_per_pdf_point,
          is_construction_template: isConstructionTemplateAsset(asset.id),
        },
        { onConflict: "package_id,asset_key" },
      );
    if (rowErr) throw new Error(`course_v2_assets upsert failed for ${asset.id}: ${rowErr.message}`);
    uploaded += 1;
  }

  return { uploaded, missing, uploadFailures };
}

export async function persistMathCourseV2Package(
  scope: FamilyScope,
  ctx: MathCourseV2PersistContext,
  parsed: ParsedMathCourseV2Package,
  assetFiles: Map<string, Uint8Array> = new Map(),
): Promise<MathCourseV2PersistSummary> {
  if (!parsed.course) throw new Error("persistMathCourseV2Package: course is null — nothing to persist");
  const course = parsed.course;

  const { data: pkg, error: pkgErr } = await scope.client
    .from("course_v2_packages")
    .upsert(
      {
        owner_family_id: scope.familyId,
        subject_id: ctx.subjectId,
        package_key: course.id,
        title: course.title,
        language: course.language,
        grade: course.grade,
        part: course.part,
        content_revision: course.content_revision,
        source_file_name: course.source_file_name,
        source_sha256: course.source_sha256,
        counts: { lessons: parsed.lessons.length, screens: parsed.screens.length, questions: parsed.questions.length, exercises: parsed.exercises.length },
        status: "active",
        last_import_errors: parsed.errors,
        last_import_warnings: parsed.warnings,
        imported_at: new Date().toISOString(),
      },
      { onConflict: "owner_family_id,package_key" },
    )
    .select("id")
    .single<{ id: string }>();
  if (pkgErr) throw new Error(`course_v2_packages upsert failed: ${pkgErr.message}`);
  const packageId = pkg.id;

  const { uploaded, missing, uploadFailures } = await persistAssets(scope, packageId, parsed, assetFiles);

  // Exercise-level flags from assets/source_issues, computed up front so
  // the exercises upsert loop below is a pure write.
  const constructionAssetKeys = new Set(parsed.assets.filter((a) => isConstructionTemplateAsset(a.id)).map((a) => a.id));
  const exerciseIdsWithIssue = new Set(parsed.sourceIssues.map((s) => s.exercise_id));

  let lessonsImported = 0;
  const lessonIdByKey = new Map<string, string>();
  for (const lesson of parsed.lessons) {
    const { data: existing } = await scope.client.from("course_v2_lessons").select("id, topic_id").eq("package_id", packageId).eq("lesson_key", lesson.id).maybeSingle<{ id: string; topic_id: string | null }>();

    const printedPages = Array.isArray((lesson.source as Record<string, unknown>)?.printed_pages) ? ((lesson.source as Record<string, unknown>).printed_pages as number[]) : [];
    let topicId = existing?.topic_id ?? null;
    const topicFields = {
      title: lesson.title,
      page_from: printedPages[0] ?? null,
      page_to: printedPages[printedPages.length - 1] ?? null,
      sort_order: lesson.order,
      grade: course.grade,
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

    const { data: savedLesson, error: lessonErr } = await scope.client
      .from("course_v2_lessons")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          subject_id: ctx.subjectId,
          topic_id: topicId,
          lesson_key: lesson.id,
          order_no: lesson.order,
          kind: lesson.kind,
          title: lesson.title,
          objectives: lesson.objectives,
          prerequisites: lesson.prerequisites,
          printed_page_from: printedPages[0] ?? null,
          printed_page_to: printedPages[printedPages.length - 1] ?? null,
          screen_ids: lesson.screen_ids,
          exercise_ids: lesson.exercise_ids,
          guided_practice_question_ids: lesson.guided_practice_question_ids,
          quiz_id: lesson.quiz_id,
          status: "active",
        },
        { onConflict: "package_id,lesson_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (lessonErr) throw new Error(`course_v2_lessons upsert failed for ${lesson.id}: ${lessonErr.message}`);
    lessonIdByKey.set(lesson.id, savedLesson.id);
    lessonsImported += 1;
  }

  let screensImported = 0;
  for (const screen of parsed.screens) {
    const lessonId = lessonIdByKey.get(screen.lesson_id);
    if (!lessonId) continue; // reported as a warning upstream (cross-check), nothing more to do here.
    const { error } = await scope.client
      .from("course_v2_screens")
      .upsert(
        {
          owner_family_id: scope.familyId,
          lesson_id: lessonId,
          screen_key: screen.id,
          order_no: screen.order,
          role: screen.role,
          title: screen.title,
          display_md: screen.display_md,
          narration: screen.narration,
          pause_after: screen.pause_after,
          equations_latex: screen.equations_latex,
        },
        { onConflict: "lesson_id,screen_key" },
      );
    if (error) throw new Error(`course_v2_screens upsert failed for ${screen.id}: ${error.message}`);
    screensImported += 1;
  }

  let questionsImported = 0;
  const questionIdByKey = new Map<string, string>();
  for (const q of parsed.questions) {
    const lessonId = lessonIdByKey.get(q.lesson_id);
    if (!lessonId) continue;
    const { data: saved, error } = await scope.client
      .from("course_v2_questions")
      .upsert(
        {
          owner_family_id: scope.familyId,
          lesson_id: lessonId,
          question_key: q.id,
          max_points: q.max_points,
          display_md: q.display_md,
          narration: q.narration,
          options: q.options,
        },
        { onConflict: "lesson_id,question_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`course_v2_questions upsert failed for ${q.id}: ${error.message}`);
    questionIdByKey.set(q.id, saved.id);
    questionsImported += 1;
  }

  let questionKeysImported = 0;
  for (const key of parsed.questionKeys) {
    const questionId = questionIdByKey.get(key.question_id);
    if (!questionId) continue;
    const { error } = await scope.client
      .from("course_v2_question_keys")
      .upsert(
        {
          owner_family_id: scope.familyId,
          question_id: questionId,
          correct_option_id: key.correct_option_id,
          hint: key.hint,
          hint_narration: key.hint_narration,
          explanation_md: key.explanation_md,
          explanation_narration: key.explanation_narration,
          option_feedback: key.option_feedback,
          equations_latex: key.equations_latex,
          certificate: key.certificate,
        },
        { onConflict: "question_id" },
      );
    if (error) throw new Error(`course_v2_question_keys upsert failed for ${key.id}: ${error.message}`);
    questionKeysImported += 1;
  }

  let quizzesImported = 0;
  const quizIdByKey = new Map<string, string>();
  for (const quiz of parsed.quizzes) {
    const lessonId = lessonIdByKey.get(quiz.lesson_id);
    if (!lessonId) continue;
    const { data: saved, error } = await scope.client
      .from("course_v2_quizzes")
      .upsert(
        {
          owner_family_id: scope.familyId,
          lesson_id: lessonId,
          quiz_key: quiz.id,
          title: quiz.title,
          question_count: quiz.question_count,
          max_points: quiz.max_points,
          mastery_threshold: quiz.mastery_threshold,
          scoring: quiz.scoring,
        },
        { onConflict: "lesson_id,quiz_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`course_v2_quizzes upsert failed for ${quiz.id}: ${error.message}`);
    quizIdByKey.set(quiz.id, saved.id);
    quizzesImported += 1;
  }

  let quizItemsImported = 0;
  for (const item of parsed.quizItems) {
    const quizId = quizIdByKey.get(item.quiz_id);
    const questionId = questionIdByKey.get(item.question_id);
    if (!quizId || !questionId) continue;
    const { error } = await scope.client
      .from("course_v2_quiz_items")
      .upsert(
        { owner_family_id: scope.familyId, quiz_id: quizId, question_id: questionId, order_no: item.order, max_points: item.max_points },
        { onConflict: "quiz_id,question_id" },
      );
    if (error) throw new Error(`course_v2_quiz_items upsert failed for ${item.id}: ${error.message}`);
    quizItemsImported += 1;
  }

  let exercisesImported = 0;
  const exerciseIdByKey = new Map<string, string>();
  for (const ex of parsed.exercises) {
    const lessonId = lessonIdByKey.get(ex.lesson_id) ?? null;
    const hasConstructionTemplate = ex.asset_ids.some((id) => constructionAssetKeys.has(id));
    const { data: saved, error } = await scope.client
      .from("course_v2_exercises")
      .upsert(
        {
          owner_family_id: scope.familyId,
          package_id: packageId,
          lesson_id: lessonId,
          exercise_key: ex.id,
          original_number: ex.original_number,
          origin: ex.origin,
          display_md: ex.display_md,
          narration: ex.narration,
          asset_ids: ex.asset_ids,
          status: ex.status,
          grading_mode: ex.grading_mode,
          has_construction_template: hasConstructionTemplate,
          has_source_issue: exerciseIdsWithIssue.has(ex.id),
        },
        { onConflict: "package_id,exercise_key" },
      )
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`course_v2_exercises upsert failed for ${ex.id}: ${error.message}`);
    exerciseIdByKey.set(ex.id, saved.id);
    exercisesImported += 1;
  }

  let exerciseSolutionsImported = 0;
  for (const sol of parsed.exerciseSolutions) {
    const exerciseId = exerciseIdByKey.get(sol.exercise_id);
    if (!exerciseId) continue;
    const { error } = await scope.client
      .from("course_v2_exercise_solutions")
      .upsert(
        { owner_family_id: scope.familyId, exercise_id: exerciseId, hint: sol.hint, verification_note: sol.verification_note, status: sol.status, parts: sol.parts },
        { onConflict: "exercise_id" },
      );
    if (error) throw new Error(`course_v2_exercise_solutions upsert failed for ${sol.id}: ${error.message}`);
    exerciseSolutionsImported += 1;
  }

  let sourceIssuesImported = 0;
  for (const issue of parsed.sourceIssues) {
    const exerciseId = exerciseIdByKey.get(issue.exercise_id);
    if (!exerciseId) continue;
    const { error } = await scope.client.from("course_v2_source_issues").upsert({ owner_family_id: scope.familyId, exercise_id: exerciseId, issue: issue.issue }, { onConflict: "exercise_id" });
    if (error) throw new Error(`course_v2_source_issues upsert failed for ${issue.id}: ${error.message}`);
    sourceIssuesImported += 1;
  }

  return {
    packageId,
    lessonsImported,
    screensImported,
    questionsImported,
    questionKeysImported,
    quizzesImported,
    quizItemsImported,
    exercisesImported,
    exerciseSolutionsImported,
    sourceIssuesImported,
    assetsUploaded: uploaded,
    assetsMissing: missing,
    assetUploadFailures: uploadFailures,
  };
}
