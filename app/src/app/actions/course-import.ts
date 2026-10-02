"use server";

import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { parseCoursePackageZip, type ImportIssue } from "@/server/lessons/courseImport";
import { persistCoursePackage } from "@/server/lessons/coursePersist";
import { parseLiteratureCourseZip } from "@/server/lessons/literatureImport";
import { persistLiteratureTopic } from "@/server/lessons/literatureExtraction";
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

  // 2026-10-02 incident: this used to select a `grade` column that does not
  // exist on `public.subjects` (it's a `materials` column, see
  // `literature-extraction.ts`) — the query errored, the error was
  // discarded (only `data` destructured), and the real subject got reported
  // as "не знайдено" even though it existed. Same bug class as the earlier
  // `subjects.name` vs `name_uk` incidents this week: never destructure
  // only `data` from a query whose shape you aren't 100% sure of.
  // `grade` isn't actually needed from the subject anyway — every lesson in
  // the package already carries its own `grade` field (`lesson.grade` below
  // in `persistCoursePackage`), this was only ever a fallback.
  const { data: subject, error: subjectErr } = await scope.select("subjects", "id, name_uk").eq("id", subjectParsed.data).maybeSingle<{ id: string; name_uk: string }>();
  if (subjectErr) return { status: "error", message: `Не вдалося перевірити предмет: ${subjectErr.message}` };
  if (!subject) return { status: "error", message: "Предмет не знайдено." };

  try {
    const { data: zipBlob, error: downloadErr } = await client.storage.from(STAGING_BUCKET).download(input.storagePath);
    if (downloadErr || !zipBlob) {
      return { status: "error", message: `Не вдалося завантажити архів зі сховища (${downloadErr?.message ?? "файл не знайдено"}).` };
    }
    const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());

    const parsed = parseCoursePackageZip(zipBytes);
    if (!parsed.manifest) {
      // 2026-10-02: "Книга/уроки" now accepts BOTH package shapes through the
      // same button — the manifest.json-anchored (image-based, S34) one
      // tried above, and the older text-only lessons/NN.md + tests/NN.json
      // one (literatureImport.ts, S33's $0 path) as a fallback here. Before
      // this, a text-only zip silently hit the S34-only error path with a
      // confusing "файл відсутній у архіві" — two upload buttons for two
      // formats was exactly the confusion the PO flagged.
      const { topics, warnings: litWarnings } = parseLiteratureCourseZip(zipBytes);
      if (topics.length > 0) {
        // The text format persists topics against a `materials` row (a real
        // already-indexed textbook PDF — `literature-import.ts`'s existing
        // assumption), not just a subject. Pick the most recently added
        // material already linked to this subject; a text course can't
        // invent one (every `materials` row needs a real `drive_file_id`).
        const { data: material } = await scope
          .select("materials", "id, title, name, grade")
          .eq("subject_id", subject.id)
          .order("added_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ id: string; title: string | null; name: string; grade: number | null }>();
        if (!material) {
          return {
            status: "error",
            message:
              "Це текстовий формат курсу (lessons/NN.md) — для нього спершу потрібна вже завантажена книга-підручник для цього предмета (вкладка «Мої книги»), а архів уроків прив'язується до неї.",
          };
        }
        let sortOrder = 0;
        let active = 0;
        for (const topic of topics.sort((a, b) => a.topicNo - b.topicNo)) {
          sortOrder += 1;
          const saved = await persistLiteratureTopic(scope, { subjectId: subject.id, materialId: material.id, grade: material.grade }, topic, sortOrder, "manual_import", null);
          if (saved.status === "active") active += 1;
        }
        return {
          status: "ok",
          summary: {
            packageTitle: material.title ?? material.name,
            subjectName: subject.name_uk,
            lessonsImported: topics.length,
            lessonsSkipped: 0,
            lessonsNeedingReview: topics.length - active,
            testsImported: topics.length,
            exercisesImported: 0,
            assetsUploaded: 0,
            assetsMissingFromZip: [],
            errors: [],
            warnings: litWarnings.map((w) => ({ file: w.topicNo != null ? `тема ${w.topicNo}` : null, field: w.field, message: w.message })),
          },
        };
      }
      return {
        status: "error",
        message: `Не вдалося розпізнати пакет: ${parsed.errors.map((e) => e.message).join("; ") || "manifest.json відсутній або пошкоджений, і текстовий формат (lessons/NN.md) теж не знайдено"}.`,
      };
    }
    if (parsed.lessons.length === 0) {
      return { status: "error", message: "У архіві не знайдено жодного придатного уроку (lessons/*.json) — перевірте структуру пакета." };
    }

    const summary = await persistCoursePackage(scope, { subjectId: subject.id, grade: null }, parsed);

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
