"use client";

import { useState } from "react";
import { importLiteratureV3Action, type LiteratureV3ImportSummary } from "@/app/actions/literature-course-v3";
import { withBusySignal } from "@/lib/busy-signal";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";
import type { SubjectOption } from "@/server/books/queries";
import { parentButton, parentInput } from "@/app/parent/ui";

/** Universal chapter package: seven JSON files and two optional media ZIPs.
 * Uploads go directly to staging storage to avoid the Vercel body-size limit. */

type UiState =
  | { status: "idle" }
  | { status: "uploading"; step: string }
  | { status: "processing" }
  | { status: "done"; summary: LiteratureV3ImportSummary }
  | { status: "error"; message: string };

async function uploadOneToStaging(file: File, setStep: (s: string) => void): Promise<{ path: string } | { error: string }> {
  setStep(`завантаження ${file.name}…`);
  const initRes = await fetch("/api/parent/literature-v3-import/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: file.name, size: file.size }),
  });
  if (!initRes.ok) return { error: `не вдалося підготувати завантаження ${file.name} (код ${initRes.status})` };
  const { token, path } = (await initRes.json()) as { signedUrl: string; token: string; path: string };

  const client = getBrowserSupabaseStorageClient();
  if (!client) return { error: "сховище Supabase не налаштоване в браузері" };
  const { error } = await client.storage.from("course_import_staging").uploadToSignedUrl(path, token, file);
  if (error) return { error: `${file.name}: ${error.message}` };
  return { path };
}

const FILE_FIELDS = [
  { key: "packageFile", label: "package.json (маніфест пакета)", required: true },
  { key: "courseFile", label: "public/course.json", required: true },
  { key: "readingsFile", label: "public/readings.json", required: true },
  { key: "teacherFile", label: "private/teacher.json", required: true },
  { key: "assetsFile", label: "catalog/assets.json", required: true },
  { key: "pagesFile", label: "catalog/pages.json", required: true },
  { key: "taskTablesFile", label: "catalog/task_tables.json", required: true },
] as const;
type FileFieldKey = (typeof FILE_FIELDS)[number]["key"];

export function LiteratureV3ImportPanel({ subjects }: { subjects: SubjectOption[] }) {
  const [subjectId, setSubjectId] = useState("");
  const [files, setFiles] = useState<Record<FileFieldKey, File | null>>({
    packageFile: null,
    courseFile: null,
    readingsFile: null,
    teacherFile: null,
    assetsFile: null,
    pagesFile: null,
    taskTablesFile: null,
  });
  const [binariesZip, setBinariesZip] = useState<File | null>(null);
  const [lessonPdfsZip, setLessonPdfsZip] = useState<File | null>(null);
  const [state, setState] = useState<UiState>({ status: "idle" });

  async function doImport() {
    if (!subjectId) return setState({ status: "error", message: "Оберіть предмет." });
    const missing = FILE_FIELDS.filter((f) => f.required && !files[f.key]);
    if (missing.length > 0) {
      return setState({ status: "error", message: `Бракує обов’язкових файлів: ${missing.map((f) => f.label).join(", ")}.` });
    }
    for (const f of [...Object.values(files), binariesZip, lessonPdfsZip]) {
      if (f && f.size > MAX_COURSE_ZIP_BYTES) return setState({ status: "error", message: `Файл ${f.name} завеликий.` });
    }

    let step = "";
    setState({ status: "uploading", step });
    const setStep = (s: string) => {
      step = s;
      setState({ status: "uploading", step: s });
    };

    const uploaded: Partial<Record<FileFieldKey, string>> = {};
    for (const f of FILE_FIELDS) {
      const file = files[f.key];
      if (!file) continue;
      const res = await uploadOneToStaging(file, setStep);
      if ("error" in res) return setState({ status: "error", message: res.error });
      uploaded[f.key] = res.path;
    }
    let binariesZipPath: string | undefined;
    if (binariesZip) {
      const zip = await uploadOneToStaging(binariesZip, setStep);
      if ("error" in zip) return setState({ status: "error", message: zip.error });
      binariesZipPath = zip.path;
    }
    let lessonPdfsZipPath: string | undefined;
    if (lessonPdfsZip) {
      const zip = await uploadOneToStaging(lessonPdfsZip, setStep);
      if ("error" in zip) return setState({ status: "error", message: zip.error });
      lessonPdfsZipPath = zip.path;
    }

    setState({ status: "processing" });
    const result = await importLiteratureV3Action({
      subjectId,
      packageStoragePath: uploaded.packageFile!,
      courseStoragePath: uploaded.courseFile!,
      readingsStoragePath: uploaded.readingsFile!,
      teacherStoragePath: uploaded.teacherFile!,
      assetsStoragePath: uploaded.assetsFile,
      pagesStoragePath: uploaded.pagesFile,
      taskTablesStoragePath: uploaded.taskTablesFile,
      binariesZipStoragePath: binariesZipPath,
      lessonPdfsZipStoragePath: lessonPdfsZipPath,
    });
    if (result.status === "ok") setState({ status: "done", summary: result.summary });
    else setState({ status: "error", message: result.message });
  }

  const busy = state.status === "uploading" || state.status === "processing";

  return (
    <div className="flex flex-col gap-3.5">
      <a href="/content-package-prompt.md" download className="text-[13px] font-bold text-p-text underline">
        Завантажити промпт для ChatGPT — спільний формат усіх предметів
      </a>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">Предмет</span>
        <select className={parentInput} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy}>
          <option value="">Оберіть предмет…</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      {FILE_FIELDS.map((f) => (
        <label key={f.key} className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold text-p-text">{f.label}</span>
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => setFiles((prev) => ({ ...prev, [f.key]: e.target.files?.[0] ?? null }))}
            className={parentInput}
          />
        </label>
      ))}
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">ZIP assets — ілюстрації (необов’язково)</span>
        <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => setBinariesZip(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">ZIP lessons — PDF уроків (необов’язково)</span>
        <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => setLessonPdfsZip(e.target.files?.[0] ?? null)} className={parentInput} />
        <span className="text-xs text-p-muted">Додайте окремий архів папки lessons або lesson_pdfs. Обидва ZIP можна пропустити. Сім JSON завантажуються окремо, як раніше.</span>
      </label>

      <button type="button" disabled={busy} onClick={() => void withBusySignal(doImport)} className={parentButton}>
        {state.status === "uploading" ? state.step : state.status === "processing" ? "Обробка…" : "📤 Імпортувати"}
      </button>

      {state.status === "error" && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {state.message}
        </p>
      )}
      {state.status === "done" && <LiteratureV3ImportResult summary={state.summary} />}
    </div>
  );
}

function LiteratureV3ImportResult({ summary }: { summary: LiteratureV3ImportSummary }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-p-line bg-p-bg p-3.5">
      <p role="status" className="text-[13px] font-bold text-p-success">
        Імпортовано {summary.lessonsImported} уроків, {summary.screensImported} екранів, {summary.worksImported} творів, {summary.readingItemsImported} фрагментів читання, {summary.biographiesImported} біографій, {summary.questionsImported} питань квізу.
      </p>
      <p className="text-xs text-p-muted">
        {summary.packageTitle} · {summary.subjectName} · ключів відповідей: {summary.questionKeysImported} · сторінок у покажчику: {summary.pagesImported} · файлів завантажено: {summary.assetsUploaded}
      </p>
      {summary.assetsMissing.length > 0 && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          Текст уроків імпортовано, але {summary.assetsMissing.length} файлів не завантажено.
          Відповідні ілюстрації та сторінки підручника поки не відкриватимуться.
          Додайте архів зі справжніми зображеннями й PDF та повторіть імпорт того самого пакета.
          Самі JSON-файли містять лише посилання на них.
        </p>
      )}
      {summary.assetsMissing.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px] font-bold text-p-text">Незавантажені файли ({summary.assetsMissing.length})</summary>
          <ul className="mt-1.5 list-disc pl-5 text-xs text-p-muted">
            {summary.assetsMissing.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      {summary.errors.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-[13px] font-bold text-p-danger">Помилки ({summary.errors.length})</summary>
          <ul className="mt-1.5 list-disc pl-5 text-xs text-p-muted">
            {summary.errors.map((e, i) => (
              <li key={i}>
                {e.file} · {e.field}: {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.warnings.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px] font-bold text-p-text">Попередження ({summary.warnings.length})</summary>
          <ul className="mt-1.5 list-disc pl-5 text-xs text-p-muted">
            {summary.warnings.map((w, i) => (
              <li key={i}>
                {w.file} · {w.field}: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
