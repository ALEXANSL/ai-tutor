"use server";

import { z } from "zod";
import { requireChild, requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { narrationTextHash, synthesizeNarration } from "@/server/lessons/narration";
import { combineMathCourseV2Package, parseMathCourseV2Private, parseMathCourseV2Public, type ImportIssue } from "@/server/lessons/mathCourseV2Import";
import { persistMathCourseV2Package } from "@/server/lessons/mathCourseV2Persist";
import { createServiceClient } from "@/server/supabase/clients";
import { unzipSync } from "fflate";

/**
 * S35 server actions — the ONLY code paths that ever read
 * `course_v2_question_keys`/`course_v2_exercise_solutions`/
 * `course_v2_source_issues` (no RLS select grant exists for them at all,
 * see the migration; a service-role client bypasses RLS, which is exactly
 * why reading them is confined to these two narrow, auth-gated functions).
 */

const UUID = z.string().uuid();

// ---------------------------------------------------------------------------
// submitQuestionAnswerAction — the "keys are never sent before the answer" guarantee.
// ---------------------------------------------------------------------------

export interface QuestionAnswerResult {
  correct: boolean;
  correctOptionId: string;
  explanationMd: string;
  explanationNarration: string;
  hint: string;
  optionFeedback: { id: string; feedback: string }[];
}

export type SubmitQuestionAnswerState = { status: "ok"; result: QuestionAnswerResult } | { status: "error"; message: string };

interface QuestionKeyRow {
  correct_option_id: string;
  explanation_md: string;
  explanation_narration: string;
  hint: string;
  option_feedback: { id: string; feedback: string; feedback_narration: string }[];
}

export async function submitQuestionAnswerAction(input: { questionId: string; optionId: string }): Promise<SubmitQuestionAnswerState> {
  const { ctx } = await requireChild();
  const questionParsed = UUID.safeParse(input.questionId);
  if (!questionParsed.success || !input.optionId) return { status: "error", message: "Невірні дані питання." };

  // Confirm the question actually belongs to this family (RLS does this for
  // normal reads; the service-role lookup below bypasses RLS entirely, so
  // this explicit check is the ONLY thing stopping one family from probing
  // another family's answer key by guessing a question id).
  const scope = forFamily(ctx.familyId);
  const { data: question } = await scope.select("course_v2_questions", "id").eq("id", questionParsed.data).maybeSingle<{ id: string }>();
  if (!question) return { status: "error", message: "Питання не знайдено." };

  const service = createServiceClient();
  const { data: key, error } = await service
    .from("course_v2_question_keys")
    .select("correct_option_id, explanation_md, explanation_narration, hint, option_feedback")
    .eq("question_id", questionParsed.data)
    .maybeSingle<QuestionKeyRow>();
  if (error || !key) return { status: "error", message: "Ключ до питання відсутній." };

  const correct = key.correct_option_id === input.optionId;

  // Best-effort progress log — never blocks the result.
  await service
    .from("course_v2_question_attempts")
    .insert({ owner_family_id: ctx.familyId, question_id: questionParsed.data, selected_option_id: input.optionId, is_correct: correct })
    .then(
      () => {},
      () => {},
    );

  return {
    status: "ok",
    result: {
      correct,
      correctOptionId: key.correct_option_id,
      explanationMd: key.explanation_md,
      explanationNarration: key.explanation_narration,
      hint: key.hint,
      optionFeedback: key.option_feedback.map((f) => ({ id: f.id, feedback: f.feedback })),
    },
  };
}

// ---------------------------------------------------------------------------
// revealExerciseSolutionAction — shown on request, never alongside the exercise itself.
// ---------------------------------------------------------------------------

export interface ExerciseSolutionPartView {
  label: string;
  stepsMd: string[];
  answerMd: string;
}

export interface ExerciseSolutionResult {
  hint: string;
  parts: ExerciseSolutionPartView[];
  /** Short, generic warning when `course_v2_source_issues` has a row for this exercise — never the raw issue payload (tutor-only detail), per `tutor_policy`'s "не оцінювати автоматично єдиним числом". */
  sourceIssueWarning: string | null;
}

export type RevealExerciseSolutionState = { status: "ok"; result: ExerciseSolutionResult } | { status: "error"; message: string };

interface SolutionRow {
  hint: string;
  parts: { label: string; steps_md: string[]; answer_md: string }[];
}

export async function revealExerciseSolutionAction(input: { exerciseId: string }): Promise<RevealExerciseSolutionState> {
  const { ctx } = await requireChild();
  const exerciseParsed = UUID.safeParse(input.exerciseId);
  if (!exerciseParsed.success) return { status: "error", message: "Невірний ідентифікатор вправи." };

  const scope = forFamily(ctx.familyId);
  const { data: exercise } = await scope.select("course_v2_exercises", "id, has_source_issue").eq("id", exerciseParsed.data).maybeSingle<{ id: string; has_source_issue: boolean }>();
  if (!exercise) return { status: "error", message: "Вправу не знайдено." };

  const service = createServiceClient();
  const { data: solution, error } = await service.from("course_v2_exercise_solutions").select("hint, parts").eq("exercise_id", exerciseParsed.data).maybeSingle<SolutionRow>();
  if (error || !solution) return { status: "error", message: "Розбір цієї вправи ще не готовий." };

  return {
    status: "ok",
    result: {
      hint: solution.hint,
      parts: solution.parts.map((p) => ({ label: p.label, stepsMd: p.steps_md, answerMd: p.answer_md })),
      sourceIssueWarning: exercise.has_source_issue
        ? "Ця вправа має особливість умови — перевір відповідь разом із дорослим чи репетитором, а не лише за одним числом."
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// narrateMathCourseV2Action — "🔊 Слухати" button, child-triggered only (never autoplay).
// ---------------------------------------------------------------------------

const NARRATABLE_TABLES = new Set(["course_v2_screens", "course_v2_exercises"]);

export type NarrateState = { status: "ok"; audioBase64: string; audioMime: string } | { status: "unavailable" } | { status: "error"; message: string };

/**
 * Generic narration-with-cache for a `course_v2_*` field whose text the
 * client already has (it is public content — this action only adds the
 * TTS audio, never reveals anything new). `refTable`/`refId` identify the
 * cache row (`course_v2_narration_cache`, keyed by table+id+field); `text`
 * is re-hashed server-side so a stale client never poisons the cache with
 * the wrong audio for a given hash.
 */
export async function narrateMathCourseV2Action(input: { refTable: string; refId: string; field: string; text: string }): Promise<NarrateState> {
  const { ctx } = await requireChild();
  if (!NARRATABLE_TABLES.has(input.refTable) || !UUID.safeParse(input.refId).success) return { status: "error", message: "Невірне поле для озвучення." };

  const scope = forFamily(ctx.familyId);
  // Confirm the row belongs to this family before synthesizing/caching anything for it.
  const { data: owns } = await scope.select(input.refTable, "id").eq("id", input.refId).maybeSingle<{ id: string }>();
  if (!owns) return { status: "error", message: "Не знайдено." };

  const hash = narrationTextHash(input.text);
  const service = createServiceClient();
  const { data: cached } = await service
    .from("course_v2_narration_cache")
    .select("audio_base64, audio_mime, text_hash")
    .eq("ref_table", input.refTable)
    .eq("ref_id", input.refId)
    .eq("field", input.field)
    .maybeSingle<{ audio_base64: string; audio_mime: string; text_hash: string }>();
  if (cached && cached.text_hash === hash) return { status: "ok", audioBase64: cached.audio_base64, audioMime: cached.audio_mime };

  const audio = await synthesizeNarration(ctx.familyId, { table: input.refTable, id: input.refId }, input.text);
  if (!audio) return { status: "unavailable" };

  await service
    .from("course_v2_narration_cache")
    .upsert(
      { owner_family_id: ctx.familyId, ref_table: input.refTable, ref_id: input.refId, field: input.field, text_hash: hash, audio_base64: audio.audioBase64, audio_mime: audio.mimeType, cached_at: new Date().toISOString() },
      { onConflict: "ref_table,ref_id,field" },
    )
    .then(
      () => {},
      () => {},
    );

  return { status: "ok", audioBase64: audio.audioBase64, audioMime: audio.mimeType };
}

// ---------------------------------------------------------------------------
// importMathCourseV2Action — parent-only, $0 import of the two staged JSON files
// (+ an optional staged figures zip for the 35 assets).
// ---------------------------------------------------------------------------

export interface MathCourseV2ImportSummary {
  packageTitle: string;
  subjectName: string;
  lessonsImported: number;
  screensImported: number;
  questionsImported: number;
  exercisesImported: number;
  assetsUploaded: number;
  assetsMissing: string[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}
export type MathCourseV2ImportState = { status: "ok"; summary: MathCourseV2ImportSummary } | { status: "error"; message: string };

const STAGING_BUCKET = "course_import_staging";

function collectAssetFiles(entries: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const [key, bytes] of Object.entries(entries)) {
    const normalized = key.replace(/^\.?\//, "");
    if (normalized.startsWith("assets/") && !normalized.endsWith("/")) map.set(normalized, bytes);
  }
  return map;
}

export async function importMathCourseV2Action(input: { subjectId: string; publicStoragePath: string; privateStoragePath: string; assetsZipStoragePath?: string }): Promise<MathCourseV2ImportState> {
  const { familyId } = await requireParentAccess();
  const subjectParsed = UUID.safeParse(input.subjectId);
  if (!subjectParsed.success) return { status: "error", message: "Невірний ідентифікатор предмета." };
  for (const p of [input.publicStoragePath, input.privateStoragePath, input.assetsZipStoragePath]) {
    if (p && !p.startsWith(`${familyId}/`)) return { status: "error", message: "Невірний шлях завантаженого файлу." };
  }

  const client = createServiceClient();
  const scope = forFamily(familyId, client);
  const { data: subject, error: subjectErr } = await scope.select("subjects", "id, name_uk").eq("id", subjectParsed.data).maybeSingle<{ id: string; name_uk: string }>();
  if (subjectErr) return { status: "error", message: `Не вдалося перевірити предмет: ${subjectErr.message}` };
  if (!subject) return { status: "error", message: "Предмет не знайдено." };

  const toCleanup = [input.publicStoragePath, input.privateStoragePath, input.assetsZipStoragePath].filter((p): p is string => !!p);
  try {
    const [{ data: pubBlob, error: pubErr }, { data: privBlob, error: privErr }] = await Promise.all([
      client.storage.from(STAGING_BUCKET).download(input.publicStoragePath),
      client.storage.from(STAGING_BUCKET).download(input.privateStoragePath),
    ]);
    if (pubErr || !pubBlob) return { status: "error", message: `Не вдалося завантажити public/course.json (${pubErr?.message ?? "файл не знайдено"}).` };
    if (privErr || !privBlob) return { status: "error", message: `Не вдалося завантажити private/teacher.json (${privErr?.message ?? "файл не знайдено"}).` };

    let publicJson: unknown;
    let privateJson: unknown;
    try {
      publicJson = JSON.parse(await pubBlob.text());
      privateJson = JSON.parse(await privBlob.text());
    } catch (e) {
      return { status: "error", message: `Не вдалося розібрати JSON (${(e as Error).message}).` };
    }

    const pub = parseMathCourseV2Public(publicJson);
    const priv = parseMathCourseV2Private(privateJson);
    if (!pub.data.course) return { status: "error", message: `public/course.json не відповідає контракту: ${pub.errors.map((e) => e.message).join("; ")}` };
    if (priv.courseId == null) return { status: "error", message: `private/teacher.json не відповідає контракту: ${priv.errors.map((e) => e.message).join("; ")}` };
    if (priv.courseId !== pub.data.course.id) {
      return { status: "error", message: `course_id не збігається між файлами (public: "${pub.data.course.id}", private: "${priv.courseId}").` };
    }

    const parsed = combineMathCourseV2Package(pub.data, priv);

    let assetFiles = new Map<string, Uint8Array>();
    if (input.assetsZipStoragePath) {
      const { data: zipBlob, error: zipErr } = await client.storage.from(STAGING_BUCKET).download(input.assetsZipStoragePath);
      if (zipErr || !zipBlob) return { status: "error", message: `Не вдалося завантажити архів з рисунками (${zipErr?.message ?? "файл не знайдено"}).` };
      const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
      try {
        assetFiles = collectAssetFiles(unzipSync(zipBytes));
      } catch (e) {
        return { status: "error", message: `Не вдалося розпакувати архів з рисунками (${(e as Error).message}).` };
      }
    }

    const summary = await persistMathCourseV2Package(scope, { subjectId: subject.id }, parsed, assetFiles);

    return {
      status: "ok",
      summary: {
        packageTitle: pub.data.course.title,
        subjectName: subject.name_uk,
        lessonsImported: summary.lessonsImported,
        screensImported: summary.screensImported,
        questionsImported: summary.questionsImported,
        exercisesImported: summary.exercisesImported,
        assetsUploaded: summary.assetsUploaded,
        assetsMissing: summary.assetsMissing,
        errors: parsed.errors,
        warnings: [...parsed.warnings, ...summary.assetUploadFailures.map((f) => ({ file: f.path, field: "upload", message: f.message }))],
      },
    };
  } catch (e) {
    console.error(`importMathCourseV2Action failed: ${(e as Error).message}`);
    return { status: "error", message: `Не вдалося імпортувати пакет (${(e as Error).message}).` };
  } finally {
    await client.storage
      .from(STAGING_BUCKET)
      .remove(toCleanup)
      .catch(() => {});
  }
}
