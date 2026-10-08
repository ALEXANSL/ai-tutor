"use server";

import { z } from "zod";
import { requireChild, requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { explainStepAgain } from "@/server/lessons/chat";
import { combineLiteratureV2Package, parseLiteratureV2Assets, parseLiteratureV2Course, parseLiteratureV2TaskTables, parseLiteratureV2Teacher, type ImportIssue } from "@/server/lessons/literatureV2Import";
import { narrationTextHash, synthesizeNarration } from "@/server/lessons/narration";
import { persistLiteratureV2Package } from "@/server/lessons/literatureV2Persist";
import { createServiceClient } from "@/server/supabase/clients";
import { unzipSync } from "fflate";

const UUID = z.string().uuid();

// ---------------------------------------------------------------------------
// importLiteratureV2Action — parent-only, $0 import of the four staged JSON
// files (course.json, teacher.json, assets.json, task_tables.json) + an
// optional staged illustrations zip (46 images). Mirrors
// `importMathCourseV2Action`'s shape closely (see that function's own doc
// comment) — the package contract is different (open-response tasks, no
// correct-option keys), the import plumbing is the same.
// ---------------------------------------------------------------------------

export interface LiteratureV2ImportSummary {
  packageTitle: string;
  subjectName: string;
  lessonsImported: number;
  screensImported: number;
  tasksImported: number;
  taskKeysImported: number;
  taskTablesImported: number;
  assetsUploaded: number;
  assetsMissing: string[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}
export type LiteratureV2ImportState = { status: "ok"; summary: LiteratureV2ImportSummary } | { status: "error"; message: string };

const STAGING_BUCKET = "course_import_staging";

function collectAssetFiles(entries: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const [key, bytes] of Object.entries(entries)) {
    const normalized = key.replace(/^\.?\//, "");
    if (normalized.startsWith("assets/") && !normalized.endsWith("/")) map.set(normalized, bytes);
  }
  return map;
}

export async function importLiteratureV2Action(input: {
  subjectId: string;
  courseStoragePath: string;
  teacherStoragePath: string;
  assetsStoragePath: string;
  taskTablesStoragePath: string;
  illustrationsZipStoragePath?: string;
}): Promise<LiteratureV2ImportState> {
  const { familyId } = await requireParentAccess();
  const subjectParsed = UUID.safeParse(input.subjectId);
  if (!subjectParsed.success) return { status: "error", message: "Невірний ідентифікатор предмета." };
  for (const p of [input.courseStoragePath, input.teacherStoragePath, input.assetsStoragePath, input.taskTablesStoragePath, input.illustrationsZipStoragePath]) {
    if (p && !p.startsWith(`${familyId}/`)) return { status: "error", message: "Невірний шлях завантаженого файлу." };
  }

  const client = createServiceClient();
  const scope = forFamily(familyId, client);
  const { data: subject, error: subjectErr } = await scope.select("subjects", "id, name_uk").eq("id", subjectParsed.data).maybeSingle<{ id: string; name_uk: string }>();
  if (subjectErr) return { status: "error", message: `Не вдалося перевірити предмет: ${subjectErr.message}` };
  if (!subject) return { status: "error", message: "Предмет не знайдено." };

  const toCleanup = [input.courseStoragePath, input.teacherStoragePath, input.assetsStoragePath, input.taskTablesStoragePath, input.illustrationsZipStoragePath].filter((p): p is string => !!p);
  try {
    const [{ data: courseBlob, error: courseErr }, { data: teacherBlob, error: teacherErr }, { data: assetsBlob, error: assetsErr }, { data: tablesBlob, error: tablesErr }] = await Promise.all([
      client.storage.from(STAGING_BUCKET).download(input.courseStoragePath),
      client.storage.from(STAGING_BUCKET).download(input.teacherStoragePath),
      client.storage.from(STAGING_BUCKET).download(input.assetsStoragePath),
      client.storage.from(STAGING_BUCKET).download(input.taskTablesStoragePath),
    ]);
    if (courseErr || !courseBlob) return { status: "error", message: `Не вдалося завантажити public/course.json (${courseErr?.message ?? "файл не знайдено"}).` };
    if (teacherErr || !teacherBlob) return { status: "error", message: `Не вдалося завантажити private/teacher.json (${teacherErr?.message ?? "файл не знайдено"}).` };
    if (assetsErr || !assetsBlob) return { status: "error", message: `Не вдалося завантажити catalog/assets.json (${assetsErr?.message ?? "файл не знайдено"}).` };
    if (tablesErr || !tablesBlob) return { status: "error", message: `Не вдалося завантажити catalog/task_tables.json (${tablesErr?.message ?? "файл не знайдено"}).` };

    let courseJson: unknown;
    let teacherJson: unknown;
    let assetsJson: unknown;
    let tablesJson: unknown;
    try {
      courseJson = JSON.parse(await courseBlob.text());
      teacherJson = JSON.parse(await teacherBlob.text());
      assetsJson = JSON.parse(await assetsBlob.text());
      tablesJson = JSON.parse(await tablesBlob.text());
    } catch (e) {
      return { status: "error", message: `Не вдалося розібрати JSON (${(e as Error).message}).` };
    }

    const course = parseLiteratureV2Course(courseJson);
    if (!course.bookId) return { status: "error", message: `public/course.json не відповідає контракту: ${course.errors.map((e) => e.message).join("; ")}` };
    const teacher = parseLiteratureV2Teacher(teacherJson);
    const assets = parseLiteratureV2Assets(assetsJson);
    const taskTables = parseLiteratureV2TaskTables(tablesJson);

    const parsed = combineLiteratureV2Package(course, teacher, assets, taskTables);

    let assetFiles = new Map<string, Uint8Array>();
    if (input.illustrationsZipStoragePath) {
      const { data: zipBlob, error: zipErr } = await client.storage.from(STAGING_BUCKET).download(input.illustrationsZipStoragePath);
      if (zipErr || !zipBlob) return { status: "error", message: `Не вдалося завантажити архів з ілюстраціями (${zipErr?.message ?? "файл не знайдено"}).` };
      const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
      try {
        assetFiles = collectAssetFiles(unzipSync(zipBytes));
      } catch (e) {
        return { status: "error", message: `Не вдалося розпакувати архів з ілюстраціями (${(e as Error).message}).` };
      }
    }

    const summary = await persistLiteratureV2Package(scope, { subjectId: subject.id }, parsed, assetFiles);

    return {
      status: "ok",
      summary: {
        packageTitle: parsed.bookId ?? "",
        subjectName: subject.name_uk,
        lessonsImported: summary.lessonsImported,
        screensImported: summary.screensImported,
        tasksImported: summary.tasksImported,
        taskKeysImported: summary.taskKeysImported,
        taskTablesImported: summary.taskTablesImported,
        assetsUploaded: summary.assetsUploaded,
        assetsMissing: summary.assetsMissing,
        errors: parsed.errors,
        warnings: [...parsed.warnings, ...summary.assetUploadFailures.map((f) => ({ file: f.path, field: "upload", message: f.message }))],
      },
    };
  } catch (e) {
    console.error(`importLiteratureV2Action failed: ${(e as Error).message}`);
    return { status: "error", message: `Не вдалося імпортувати пакет (${(e as Error).message}).` };
  } finally {
    await client.storage
      .from(STAGING_BUCKET)
      .remove(toCleanup)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// revealLiteratureV2TaskHelpAction — hints/model answer/criteria, shown on
// request, never alongside the task itself (`literature_v2_task_keys` has no
// select grant for any client role — see its migration comment). Mirrors
// `revealExerciseSolutionAction`'s shape (S35) exactly. Misconceptions are
// deliberately NOT included in the response — tutor-only guidance, not
// something to show a child directly.
// ---------------------------------------------------------------------------

export interface LiteratureV2TaskHelpResult {
  hints: { display: string }[];
  solutionSteps: { display: string }[];
  answer: { display: string } | null;
  answerKind: string;
  criteria: { criterion: string }[];
  acceptableAlternatives: string[];
}
export type RevealLiteratureV2TaskHelpState = { status: "ok"; result: LiteratureV2TaskHelpResult } | { status: "error"; message: string };

interface TaskKeyRow {
  hints: { display: string }[];
  solution_steps: { display: string }[];
  answer: { display: string } | null;
  answer_kind: string;
  criteria: { criterion: string }[];
  acceptable_alternatives: string[];
}

export async function revealLiteratureV2TaskHelpAction(input: { taskId: string }): Promise<RevealLiteratureV2TaskHelpState> {
  const { ctx } = await requireChild();
  const taskParsed = UUID.safeParse(input.taskId);
  if (!taskParsed.success) return { status: "error", message: "Невірний ідентифікатор завдання." };

  const scope = forFamily(ctx.familyId);
  const { data: task } = await scope.select("literature_v2_tasks", "id").eq("id", taskParsed.data).maybeSingle<{ id: string }>();
  if (!task) return { status: "error", message: "Завдання не знайдено." };

  const service = createServiceClient();
  const { data: key, error } = await service
    .from("literature_v2_task_keys")
    .select("hints, solution_steps, answer, answer_kind, criteria, acceptable_alternatives")
    .eq("task_id", taskParsed.data)
    .maybeSingle<TaskKeyRow>();
  if (error || !key) return { status: "error", message: "Підказки для цього завдання ще не готові." };

  return {
    status: "ok",
    result: {
      hints: key.hints,
      solutionSteps: key.solution_steps,
      answer: key.answer?.display ? key.answer : null,
      answerKind: key.answer_kind,
      criteria: key.criteria,
      acceptableAlternatives: key.acceptable_alternatives,
    },
  };
}

// ---------------------------------------------------------------------------
// narrateLiteratureV2Action — "🔊 Слухати" button, child-triggered only
// (never autoplay for the first click — voice mode autoplay is wired the
// same way S35's `ListenButton` already does it, client-side). Shares the
// SAME generic `course_v2_narration_cache` table as S35 (its `ref_table`/
// `ref_id`/`field` key is plain text, not FK-constrained to any specific
// course_v2_* table — see that table's own migration comment).
// ---------------------------------------------------------------------------

const NARRATABLE_TABLES = new Set(["literature_v2_screens", "literature_v2_tasks"]);

export type LiteratureV2NarrateState = { status: "ok"; audioBase64: string; audioMime: string } | { status: "unavailable" } | { status: "error"; message: string };

export async function narrateLiteratureV2Action(input: { refTable: string; refId: string; field: string; text: string }): Promise<LiteratureV2NarrateState> {
  const { ctx } = await requireChild();
  if (!NARRATABLE_TABLES.has(input.refTable) || !UUID.safeParse(input.refId).success) return { status: "error", message: "Невірне поле для озвучення." };

  const scope = forFamily(ctx.familyId);
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
// explainLiteratureV2Action — "💡 Пояснити", same reused paid `tutor_chat`
// role as `explainMathCourseV2Action` (S35), just wired into this lesson type.
// ---------------------------------------------------------------------------

export type ExplainLiteratureV2State = { status: "ok"; content: string } | { status: "error"; message: string };

const explainTextSchema = z.string().trim().min(1).max(4000);

export async function explainLiteratureV2Action(input: { subjectId: string; topicId: string; stepText: string }): Promise<ExplainLiteratureV2State> {
  const { ctx, profile: child } = await requireChild();
  const subjectParsed = UUID.safeParse(input.subjectId);
  const topicParsed = UUID.safeParse(input.topicId);
  if (!subjectParsed.success || !topicParsed.success) return { status: "error", message: "Невірні дані." };
  const stepTextParsed = explainTextSchema.safeParse(input.stepText);
  if (!stepTextParsed.success) return { status: "error", message: "Немає тексту для пояснення." };

  const scope = forFamily(ctx.familyId);
  const [{ data: subject }, { data: topic }] = await Promise.all([
    scope.select("subjects", "name_uk").eq("id", subjectParsed.data).maybeSingle<{ name_uk: string }>(),
    scope.select("topics", "title").eq("id", topicParsed.data).maybeSingle<{ title: string }>(),
  ]);
  if (!subject || !topic) return { status: "error", message: "Предмет чи тему не знайдено." };

  try {
    const message = await explainStepAgain(
      ctx.familyId,
      child.id,
      child.tutor_name ?? "",
      child.tutor_name_gender,
      subjectParsed.data,
      subject.name_uk,
      topicParsed.data,
      topic.title,
      child.nickname ?? "",
      stepTextParsed.data,
    );
    return { status: "ok", content: message.content };
  } catch (e) {
    return { status: "error", message: `Не вдалося пояснити (${(e as Error).message}). Спробуй ще раз.` };
  }
}
