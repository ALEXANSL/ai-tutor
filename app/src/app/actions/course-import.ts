"use server";

import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { parseCoursePackageZip, type ImportIssue } from "@/server/lessons/courseImport";
import { persistCoursePackage } from "@/server/lessons/coursePersist";
import { createServiceClient } from "@/server/supabase/clients";
import { uk } from "@/i18n/uk";

/**
 * S34 ($0 course-package import, PO decision 2026-10-02) — step 2 of 2:
 * the browser has already PUT the zip straight into the private
 * `course_import_staging` Supabase Storage bucket
 * (`/api/parent/course-import/init`, `CourseZipUploadButton.tsx`); this
 * action takes only the resulting storage path (never the file bytes
 * themselves — no Vercel body-size limit involved here), downloads it
 * server-side, parses+validates it (`courseImport.ts` — ZERO AI calls),
 * persists it (`coursePersist.ts`), and deletes the staged zip either way
 * (success or failure) so the staging bucket never accumulates old
 * uploads.
 *
 * Mirrors `literature-import.ts`'s `LiteratureImportSummary` shape/wording
 * closely (same parent-facing UX convention) but reports this format's own
 * distinct `ImportIssue[]` (file + field + message) — PO: "не повторювати
 * мовчазні провали", so every skipped lesson/question/exercise/asset is
 * named, never just a total count.
 */

const UUID = z.string().uuid();

export interface CourseImportSummary {
  packageTitle: string;
  subjectName: string;
  lessonsImported: number;
  lessonsSkipped: number;
  lessonsNeedingReview: number;
  testsImported: number;
  exercisesImported: number;
  assetsUploaded: number;
  assetsMissingFromZip: string[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export type CourseImportState = { status: "ok"; summary: CourseImportSummary } | { status: "error"; message: string };

const STAGING_BUCKET = "course_import_staging";

export async function importCoursePackageAction(input: { subjectId: string; storagePath: string }): Promise<CourseImportState> {
  const { familyId } = await requireParentAccess();

  const subjectParsed = UUID.safeParse(input.subjectId);
  if (!subjectParsed.success) return { status: "error", message: "Невірний ідентифікатор предмета." };
  // The staging path is always `${familyId}/...` (see course-import/init) — a
  // confused-deputy guard, same spirit as `confirmUpload`'s Drive-folder check.
  if (!input.storagePath.startsWith(`${familyId}/`)) {
    return { status: "error", message: "Невірний шлях завантаженого файлу." };
  }

  const client = createServiceClient();
  const scope = forFamily(familyId, client);

  const { data: subject } = await scope.select("subjects", "id, name_uk, grade").eq("id", subjectParsed.data).maybeSingle<{ id: string; name_uk: string; grade: number | null }>();
  if (!subject) return { status: "error", message: "Предмет не знайдено." };

  try {
    const { data: zipBlob, error: downloadErr } = await client.storage.from(STAGING_BUCKET).download(input.storagePath);
    if (downloadErr || !zipBlob) {
      return { status: "error", message: `Не вдалося завантажити архів зі сховища (${downloadErr?.message ?? "файл не знайдено"}).` };
    }
    const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());

    const parsed = parseCoursePackageZip(zipBytes);
    if (!parsed.manifest) {
      return {
        status: "error",
        message: `Не вдалося розпізнати пакет: ${parsed.errors.map((e) => e.message).join("; ") || "manifest.json відсутній або пошкоджений"}.`,
      };
    }
    if (parsed.lessons.length === 0) {
      return { status: "error", message: "У архіві не знайдено жодного придатного уроку (lessons/*.json) — перевірте структуру пакета." };
    }

    const summary = await persistCoursePackage(scope, { subjectId: subject.id, grade: subject.grade }, parsed);

    return {
      status: "ok",
      summary: {
        packageTitle: parsed.manifest.title,
        subjectName: subject.name_uk,
        lessonsImported: summary.lessonsImported,
        lessonsSkipped: summary.lessonsSkipped,
        lessonsNeedingReview: summary.lessonsNeedingReview,
        testsImported: summary.testsImported,
        exercisesImported: summary.exercisesImported,
        assetsUploaded: summary.assetsUploaded,
        assetsMissingFromZip: summary.assetsMissingFromZip,
        errors: parsed.errors,
        warnings: parsed.warnings,
      },
    };
  } catch (e) {
    const detail = (e as Error).message;
    console.error(`importCoursePackageAction failed: ${detail}`);
    return { status: "error", message: `${uk.common.error} (${detail})` };
  } finally {
    // Best-effort cleanup — never block the result on it.
    await client.storage.from(STAGING_BUCKET).remove([input.storagePath]).catch(() => {});
  }
}
