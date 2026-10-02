"use client";

import { useRef, useState } from "react";
import { importCoursePackageAction, type CourseImportSummary } from "@/app/actions/course-import";
import { uk } from "@/i18n/uk";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { MAX_COURSE_ZIP_BYTES, MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import type { SubjectOption } from "@/server/books/queries";
import { parentButton, parentInput } from "@/app/parent/ui";

/**
 * "Завантажити матеріали" (S34, PO instruction 2026-10-02, exact wording in
 * the handback report) — ONE panel: Предмет dropdown, Категорія dropdown,
 * then the file picker. Three categories get three DIFFERENT levels of
 * handling, by explicit PO instruction:
 *
 * - **"Книга/уроки"** (`book_lessons`) — the FULL $0 course-package import
 *   pipeline (`courseImport.ts` → `coursePersist.ts`): parses, validates
 *   against the package's own schema, uploads every referenced image to
 *   Supabase Storage, persists lessons/tests/exercises. Zero AI calls.
 *   The zip itself goes straight from this browser to a private Supabase
 *   Storage staging bucket via a signed upload URL (`/api/parent/
 *   course-import/init`) — never through our Vercel function body — so it
 *   is not limited by the platform's ~4.5 MB request-body cap the way a
 *   plain server action upload would be.
 * - **"Додаткові посібники"** / **"Інше"** — MINIMAL handling, by the PO's
 *   own explicit scope cut: the file is still accepted and stored/
 *   associated with the chosen subject (reusing the EXACT SAME Drive
 *   resumable-upload mechanism `UploadBookButton.tsx` already uses for
 *   books — same `/api/parent/books/upload(/complete)` routes, now also
 *   given the subject/category so the resulting `materials` row is tagged
 *   `kind: "reference"` or `"other"` and `subject_manual: true` instead of
 *   left to auto-detection). NO special parsing/import logic for these two
 *   today — they just go through the ordinary book-indexing pipeline like
 *   any other PDF/EPUB in "Мої книги".
 */

type Category = "book_lessons" | "additional_guide" | "other";

type UiState =
  | { status: "idle" }
  | { status: "uploading" }
  | { status: "processing" }
  | { status: "course_done"; summary: CourseImportSummary }
  | { status: "guide_done" }
  | { status: "error"; message: string };

export function MaterialsImportPanel({ subjects, uploadEnabled }: { subjects: SubjectOption[]; uploadEnabled: boolean }) {
  const t = uk.parent.materials;
  const [subjectId, setSubjectId] = useState("");
  const [category, setCategory] = useState<Category>("book_lessons");
  const [state, setState] = useState<UiState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadCoursePackage(file: File) {
    if (file.size > MAX_COURSE_ZIP_BYTES) {
      setState({
        status: "error",
        message: `Файл завеликий: ${(file.size / 1024 / 1024).toFixed(1)} МБ, максимум ${MAX_COURSE_ZIP_BYTES / 1024 / 1024} МБ.`,
      });
      return;
    }
    setState({ status: "uploading" });
    const initRes = await fetch("/api/parent/course-import/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: file.name, size: file.size }),
    });
    if (!initRes.ok) {
      const detail = await initRes.text().catch(() => "");
      setState({ status: "error", message: `${t.failed} (крок 1/3, код ${initRes.status}${detail ? `: ${detail.slice(0, 300)}` : ""})` });
      return;
    }
    const { token, path } = (await initRes.json()) as { signedUrl: string; token: string; path: string };

    const client = getBrowserSupabaseStorageClient();
    if (!client) {
      setState({ status: "error", message: `${t.failed} (крок 2/3: сховище Supabase не налаштоване в браузері — перевір env-змінні)` });
      return;
    }
    const { error: uploadErr } = await client.storage.from("course_import_staging").uploadToSignedUrl(path, token, file);
    if (uploadErr) {
      setState({ status: "error", message: `${t.failed} (крок 2/3: ${uploadErr.message})` });
      return;
    }

    setState({ status: "processing" });
    const result = await importCoursePackageAction({ subjectId, storagePath: path });
    if (result.status === "ok") setState({ status: "course_done", summary: result.summary });
    else setState({ status: "error", message: result.message });
  }

  async function uploadGuideOrOther(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setState({
        status: "error",
        message: `Файл завеликий: ${(file.size / 1024 / 1024).toFixed(1)} МБ, максимум ${MAX_UPLOAD_BYTES / 1024 / 1024} МБ.`,
      });
      return;
    }
    setState({ status: "uploading" });
    try {
      const initRes = await fetch("/api/parent/books/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream", size: file.size }),
      });
      if (!initRes.ok) {
        const detail = await initRes.text().catch(() => "");
        setState({ status: "error", message: `${t.failed} (крок 1/3, код ${initRes.status}${detail ? `: ${detail.slice(0, 300)}` : ""})` });
        return;
      }
      const { sessionUrl } = (await initRes.json()) as { sessionUrl: string };
      const putRes = await fetch(sessionUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
      if (!putRes.ok) {
        const detail = await putRes.text().catch(() => "");
        setState({ status: "error", message: `${t.failed} (крок 2/3, код ${putRes.status}${detail ? `: ${detail.slice(0, 300)}` : ""})` });
        return;
      }
      const uploaded = (await putRes.json()) as { id: string };

      setState({ status: "processing" });
      const completeRes = await fetch("/api/parent/books/upload/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ driveFileId: uploaded.id, subjectId, category }),
      });
      if (!completeRes.ok) {
        const detail = await completeRes.text().catch(() => "");
        setState({ status: "error", message: `${t.failed} (крок 3/3, код ${completeRes.status}${detail ? `: ${detail.slice(0, 300)}` : ""})` });
        return;
      }
      setState({ status: "guide_done" });
    } catch (e) {
      setState({ status: "error", message: `${t.failed} (${(e as Error).message})` });
    }
  }

  async function onFile(file: File) {
    if (!subjectId) {
      setState({ status: "error", message: t.chooseSubjectFirst });
      return;
    }
    if (category === "book_lessons") {
      if (!file.name.toLowerCase().endsWith(".zip")) {
        setState({ status: "error", message: t.zipRequired });
        return;
      }
      await uploadCoursePackage(file);
    } else {
      const ok = /\.(pdf|epub)$/i.test(file.name);
      if (!ok) {
        setState({ status: "error", message: t.pdfEpubRequired });
        return;
      }
      await uploadGuideOrOther(file);
    }
  }

  const busy = state.status === "uploading" || state.status === "processing";
  const accept = category === "book_lessons" ? ".zip,application/zip" : ".pdf,.epub,application/pdf,application/epub+zip";

  return (
    <div className="flex flex-col gap-3.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">{t.subjectLabel}</span>
        <select className={parentInput} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy}>
          <option value="">{t.subjectPlaceholder}</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">{t.categoryLabel}</span>
        <select className={parentInput} value={category} onChange={(e) => setCategory(e.target.value as Category)} disabled={busy}>
          <option value="book_lessons">{t.category.book_lessons}</option>
          <option value="additional_guide">{t.category.additional_guide}</option>
          <option value="other">{t.category.other}</option>
        </select>
        <span className="text-xs text-p-muted">{t.categoryHint[category]}</span>
      </label>

      {category !== "book_lessons" && !uploadEnabled ? (
        <p className="text-[13px] text-p-muted">{uk.parent.books.upload.notConfigured}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onFile(file);
            }}
          />
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={parentButton}>
            {state.status === "uploading" ? t.uploading : state.status === "processing" ? t.processing : `📤 ${t.submit}`}
          </button>
        </div>
      )}

      {state.status === "error" && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {state.message}
        </p>
      )}
      {state.status === "guide_done" && (
        <p role="status" className="text-[13px] font-bold text-p-success">
          {t.guideDone}
        </p>
      )}
      {state.status === "course_done" && <CourseImportResult summary={state.summary} />}
    </div>
  );
}

function CourseImportResult({ summary }: { summary: CourseImportSummary }) {
  const t = uk.parent.materials;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-p-line bg-p-bg p-3.5">
      <p role="status" className="text-[13px] font-bold text-p-success">
        {t.courseDone(summary.lessonsImported, summary.testsImported)}
      </p>
      <p className="text-xs text-p-muted">
        {summary.packageTitle} · {summary.subjectName} · вправ: {summary.exercisesImported} · зображень: {summary.assetsUploaded}
        {summary.lessonsNeedingReview > 0 ? ` · потребують перевірки: ${summary.lessonsNeedingReview}` : ""}
      </p>
      {summary.errors.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-[13px] font-bold text-p-danger">
            {t.errorsTitle} ({summary.errors.length})
          </summary>
          <ul className="mt-1.5 list-disc pl-5 text-xs text-p-muted">
            {summary.errors.map((e, i) => (
              <li key={i}>
                {e.file ?? "—"} · {e.field}: {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.warnings.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px] font-bold text-p-text">
            {t.warningsTitle} ({summary.warnings.length})
          </summary>
          <ul className="mt-1.5 list-disc pl-5 text-xs text-p-muted">
            {summary.warnings.map((w, i) => (
              <li key={i}>
                {w.file ?? "—"} · {w.field}: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.assetsMissingFromZip.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px] font-bold text-p-text">
            {t.missingAssetsTitle} ({summary.assetsMissingFromZip.length})
          </summary>
          <ul className="mt-1.5 list-disc pl-5 text-xs text-p-muted">
            {summary.assetsMissingFromZip.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
