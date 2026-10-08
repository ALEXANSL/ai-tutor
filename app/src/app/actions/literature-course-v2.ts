"use server";

import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { combineLiteratureV2Package, parseLiteratureV2Assets, parseLiteratureV2Course, parseLiteratureV2TaskTables, parseLiteratureV2Teacher, type ImportIssue } from "@/server/lessons/literatureV2Import";
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
