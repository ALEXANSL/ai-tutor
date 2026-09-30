"use server";

import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { parseLiteratureCourseZip, type ImportWarning } from "@/server/lessons/literatureImport";
import { persistLiteratureTopic } from "@/server/lessons/literatureExtraction";
import { createServiceClient } from "@/server/supabase/clients";
import { uk } from "@/i18n/uk";

/**
 * S33 follow-up ($0 manual-course importer, PO decision 2026-09-30): the
 * "Імпортувати готовий курс (без ШІ)" trigger in `/parent/settings`. The PO
 * uploads a zip he already authored himself (any chat assistant, own
 * Google Drive) in the same `lessons/NN.md` + `tests/NN.json` format —
 * parsing is 100% deterministic (`literatureImport.ts`, no AI call), and
 * saving reuses the EXACT SAME `persistLiteratureTopic` the paid
 * `runLiteratureExtractionAction` uses, so the two paths never diverge on
 * how a topic ends up in `literature_lessons`/`literature_lesson_tests`.
 *
 * Deliberately mirrors `runLiteratureExtractionAction`'s material/subject
 * resolution — same "book already exists as a `materials` row" assumption
 * (the underlying PDF is presumably already uploaded/indexed; this is an
 * alternate, free way to fill in the SAME topics table for it), same
 * `requireParentAccess()` gate, same family resolution off the book.
 *
 * The zip itself is small (plain markdown/JSON, no PDFs) — well under
 * Vercel's request-body limit — so, unlike book uploads
 * (`UploadBookButton.tsx`), this goes straight through a normal server
 * action `FormData` upload; no resumable-upload dance needed.
 */

const UUID = z.string().uuid();
/** Generous but well under Vercel's ~4.5 MB serverless body limit — this format is plain text, never a scanned PDF. */
const MAX_IMPORT_ZIP_BYTES = 4 * 1024 * 1024;

export interface LiteratureImportTopicSummary {
  topicNo: number;
  titleUk: string;
  status: "active" | "needs_review";
  warningsCount: number;
}

export interface LiteratureImportSummary {
  materialTitle: string;
  subjectName: string;
  topics: LiteratureImportTopicSummary[];
  active: number;
  needsReview: number;
  warnings: ImportWarning[];
}

export type LiteratureImportState = { status: "ok"; summary: LiteratureImportSummary } | { status: "error"; message: string };

export async function importLiteratureCourseAction(formData: FormData): Promise<LiteratureImportState> {
  await requireParentAccess();

  const materialId = String(formData.get("materialId") ?? "");
  const materialParsed = UUID.safeParse(materialId);
  if (!materialParsed.success) {
    return { status: "error", message: "Невірний ідентифікатор підручника." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Оберіть zip-файл курсу." };
  }
  if (file.size > MAX_IMPORT_ZIP_BYTES) {
    return { status: "error", message: `Файл завеликий (максимум ${Math.round(MAX_IMPORT_ZIP_BYTES / 1024 / 1024)} МБ) — це має бути текстовий архів (markdown+json), без PDF.` };
  }

  try {
    const client = createServiceClient();
    const { data: material, error: materialError } = await client
      .from("materials")
      .select("id, owner_family_id, subject_id, title, name, grade")
      .eq("id", materialParsed.data)
      .single<{ id: string; owner_family_id: string; subject_id: string | null; title: string | null; name: string; grade: number | null }>();
    if (materialError || !material) {
      return { status: "error", message: "Підручник не знайдено." };
    }
    if (!material.subject_id) {
      return { status: "error", message: "Ця книга не прив'язана до предмета — спершу вкажіть предмет на сторінці книги." };
    }

    const scope = forFamily(material.owner_family_id, client);
    const { data: subject } = await scope.select("subjects", "id, name_uk").eq("id", material.subject_id).maybeSingle<{ id: string; name_uk: string }>();
    if (!subject) {
      return { status: "error", message: "Предмет не знайдено для цієї родини." };
    }

    const zipBytes = new Uint8Array(await file.arrayBuffer());
    const { topics, warnings } = parseLiteratureCourseZip(zipBytes);
    if (topics.length === 0) {
      return { status: "error", message: "У архіві не знайдено жодної теми (lessons/NN.md) — перевірте структуру zip." };
    }

    const materialTitle = material.title ?? material.name;
    const topicSummaries: LiteratureImportTopicSummary[] = [];
    let sortOrder = 0;
    for (const topic of topics.sort((a, b) => a.topicNo - b.topicNo)) {
      sortOrder += 1;
      const saved = await persistLiteratureTopic(
        scope,
        { subjectId: subject.id, materialId: material.id, grade: material.grade },
        topic,
        sortOrder,
        "manual_import", // never a real AI model — this topic was authored by the parent, not generated
        null, // no already-indexed `chunks` for a manually-authored course, so no work-full-text Drive file
      );
      topicSummaries.push({
        topicNo: saved.topicNo,
        titleUk: topic.titleUk,
        status: saved.status,
        warningsCount: warnings.filter((w) => w.topicNo === topic.topicNo).length,
      });
    }

    const active = topicSummaries.filter((t) => t.status === "active").length;
    return {
      status: "ok",
      summary: {
        materialTitle,
        subjectName: subject.name_uk,
        topics: topicSummaries,
        active,
        needsReview: topicSummaries.length - active,
        warnings,
      },
    };
  } catch (e) {
    const detail = (e as Error).message;
    console.error(`importLiteratureCourseAction failed: ${detail}`);
    return { status: "error", message: `${uk.common.error} (${detail})` };
  }
}
