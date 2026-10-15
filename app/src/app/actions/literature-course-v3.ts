"use server";

import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import {
  combineLiteratureV3Package,
  parseLiteratureV3Assets,
  parseLiteratureV3Course,
  parseLiteratureV3PackageManifest,
  parseLiteratureV3Pages,
  parseLiteratureV3Readings,
  parseLiteratureV3TaskTables,
  parseLiteratureV3Teacher,
  type ImportIssue,
} from "@/server/lessons/literatureV3Import";
import { persistLiteratureV3Package } from "@/server/lessons/literatureV3Persist";
import { createServiceClient } from "@/server/supabase/clients";
import { unzipSync } from "fflate";

const UUID = z.string().uuid();

// ---------------------------------------------------------------------------
// importLiteratureV3Action — parent-only, $0 import of the SEVEN staged JSON
// documents this package ships (package.json manifest + six catalogs:
// course/readings/teacher/assets/pages/task_tables) + an optional staged
// binaries zip (illustrations AND `assets/lessons/*.pdf`, 46 small per-lesson
// PDFs). Mirrors `importLiteratureV2Action`'s shape closely (see that
// function's own doc comment) — this is the only piece of S45 that was
// NOT done in the first pass (see `literatureV3Import.ts`/
// `literatureV3Persist.ts`'s own headers): without this action+route+panel,
// Alex had no way to get a package into the database other than a manual
// test call to `persistLiteratureV3Package`.
// ---------------------------------------------------------------------------

export interface LiteratureV3ImportSummary {
  packageTitle: string;
  subjectName: string;
  lessonsImported: number;
  screensImported: number;
  worksImported: number;
  readingItemsImported: number;
  biographiesImported: number;
  questionsImported: number;
  questionKeysImported: number;
  pagesImported: number;
  assetsUploaded: number;
  assetsMissing: string[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}
export type LiteratureV3ImportState = { status: "ok"; summary: LiteratureV3ImportSummary } | { status: "error"; message: string };

const STAGING_BUCKET = "course_import_staging";

/** Same convention as `literatureV2Import.ts`'s `collectAssetFiles` — zip
 * entries under `assets/` (illustrations AND `assets/lessons/L001.pdf`-style
 * per-lesson PDFs), keyed by the package's own relative path. */
function collectAssetFiles(entries: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const [key, bytes] of Object.entries(entries)) {
    const normalized = key.replace(/^\.?\//, "");
    if (normalized.startsWith("assets/") && !normalized.endsWith("/")) map.set(normalized, bytes);
  }
  return map;
}

async function downloadJson(client: ReturnType<typeof createServiceClient>, path: string, label: string): Promise<{ data: unknown } | { error: string }> {
  const { data: blob, error } = await client.storage.from(STAGING_BUCKET).download(path);
  if (error || !blob) return { error: `Не вдалося завантажити ${label} (${error?.message ?? "файл не знайдено"}).` };
  try {
    return { data: JSON.parse(await blob.text()) };
  } catch (e) {
    return { error: `Не вдалося розібрати ${label} (${(e as Error).message}).` };
  }
}

export async function importLiteratureV3Action(input: {
  subjectId: string;
  packageStoragePath: string;
  courseStoragePath: string;
  readingsStoragePath: string;
  teacherStoragePath: string;
  assetsStoragePath: string;
  pagesStoragePath: string;
  taskTablesStoragePath: string;
  binariesZipStoragePath?: string;
}): Promise<LiteratureV3ImportState> {
  const { familyId } = await requireParentAccess();
  const subjectParsed = UUID.safeParse(input.subjectId);
  if (!subjectParsed.success) return { status: "error", message: "Невірний ідентифікатор предмета." };
  const requiredPaths = [input.packageStoragePath, input.courseStoragePath, input.readingsStoragePath, input.teacherStoragePath, input.assetsStoragePath, input.pagesStoragePath, input.taskTablesStoragePath];
  for (const p of [...requiredPaths, input.binariesZipStoragePath]) {
    if (p && !p.startsWith(`${familyId}/`)) return { status: "error", message: "Невірний шлях завантаженого файлу." };
  }

  const client = createServiceClient();
  const scope = forFamily(familyId, client);
  const { data: subject, error: subjectErr } = await scope.select("subjects", "id, name_uk").eq("id", subjectParsed.data).maybeSingle<{ id: string; name_uk: string }>();
  if (subjectErr) return { status: "error", message: `Не вдалося перевірити предмет: ${subjectErr.message}` };
  if (!subject) return { status: "error", message: "Предмет не знайдено." };

  const toCleanup = [...requiredPaths, input.binariesZipStoragePath].filter((p): p is string => !!p);
  try {
    const [pkg, course, readings, teacher, assets, pages, taskTables] = await Promise.all([
      downloadJson(client, input.packageStoragePath, "package.json"),
      downloadJson(client, input.courseStoragePath, "public/course.json"),
      downloadJson(client, input.readingsStoragePath, "public/readings.json"),
      downloadJson(client, input.teacherStoragePath, "private/teacher.json"),
      downloadJson(client, input.assetsStoragePath, "catalog/assets.json"),
      downloadJson(client, input.pagesStoragePath, "catalog/pages.json"),
      downloadJson(client, input.taskTablesStoragePath, "catalog/task_tables.json"),
    ]);
    for (const r of [pkg, course, readings, teacher, assets, pages, taskTables]) {
      if ("error" in r) return { status: "error", message: r.error };
    }
    const manifest = parseLiteratureV3PackageManifest((pkg as { data: unknown }).data);
    if (!manifest.manifest) return { status: "error", message: `package.json не відповідає контракту: ${manifest.errors.map((e) => e.message).join("; ")}` };

    const parsedCourse = parseLiteratureV3Course((course as { data: unknown }).data);
    if (!parsedCourse.bookId) return { status: "error", message: `public/course.json не відповідає контракту: ${parsedCourse.errors.map((e) => e.message).join("; ")}` };
    const parsedReadings = parseLiteratureV3Readings((readings as { data: unknown }).data);
    const parsedTeacher = parseLiteratureV3Teacher((teacher as { data: unknown }).data);
    const parsedAssets = parseLiteratureV3Assets((assets as { data: unknown }).data);
    const parsedPages = parseLiteratureV3Pages((pages as { data: unknown }).data);
    const parsedTaskTables = parseLiteratureV3TaskTables((taskTables as { data: unknown }).data);

    const parsed = combineLiteratureV3Package(manifest, parsedCourse, parsedReadings, parsedTeacher, parsedAssets, parsedPages, parsedTaskTables);

    let assetFiles = new Map<string, Uint8Array>();
    if (input.binariesZipStoragePath) {
      const { data: zipBlob, error: zipErr } = await client.storage.from(STAGING_BUCKET).download(input.binariesZipStoragePath);
      if (zipErr || !zipBlob) return { status: "error", message: `Не вдалося завантажити архів з файлами (${zipErr?.message ?? "файл не знайдено"}).` };
      const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
      try {
        assetFiles = collectAssetFiles(unzipSync(zipBytes));
      } catch (e) {
        return { status: "error", message: `Не вдалося розпакувати архів з файлами (${(e as Error).message}).` };
      }
    }

    const summary = await persistLiteratureV3Package(scope, { subjectId: subject.id }, parsed, assetFiles);

    const warnings: ImportIssue[] = [...parsed.warnings, ...summary.assetUploadFailures.map((f) => ({ file: f.path, field: "upload", message: f.message }))];

    return {
      status: "ok",
      summary: {
        packageTitle: manifest.manifest.source_edition || manifest.manifest.book_id,
        subjectName: subject.name_uk,
        lessonsImported: summary.lessonsImported,
        screensImported: summary.screensImported,
        worksImported: summary.worksImported,
        readingItemsImported: summary.readingItemsImported,
        biographiesImported: summary.biographiesImported,
        questionsImported: summary.questionsImported,
        questionKeysImported: summary.questionKeysImported,
        pagesImported: summary.pagesImported,
        assetsUploaded: summary.assetsUploaded,
        assetsMissing: summary.assetsMissing,
        errors: parsed.errors,
        warnings,
      },
    };
  } catch (e) {
    console.error(`importLiteratureV3Action failed: ${(e as Error).message}`);
    return { status: "error", message: `Не вдалося імпортувати пакет (${(e as Error).message}).` };
  } finally {
    await client.storage
      .from(STAGING_BUCKET)
      .remove(toCleanup)
      .catch(() => {});
  }
}
