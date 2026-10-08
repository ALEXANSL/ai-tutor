"use client";

import { useState } from "react";
import { importLiteratureV2Action, type LiteratureV2ImportSummary } from "@/app/actions/literature-course-v2";
import { withBusySignal } from "@/lib/busy-signal";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";
import type { SubjectOption } from "@/server/books/queries";
import { parentButton, parentInput } from "@/app/parent/ui";

/**
 * S36 ($0 foreign-literature course-package v2 import, PO upload
 * 2026-10-08) — a separate panel from `MathCourseV2ImportPanel.tsx` (S35):
 * this package's contract is FOUR JSON files (course.json, teacher.json,
 * catalog/assets.json, catalog/task_tables.json) instead of two, because
 * every task here is open-response (hints/model-answer/criteria, no
 * correct-option key) — see `literatureV2Import.ts`'s header for why that
 * needs its own schema rather than reusing S35's.
 */

type UiState =
  | { status: "idle" }
  | { status: "uploading"; step: string }
  | { status: "processing" }
  | { status: "done"; summary: LiteratureV2ImportSummary }
  | { status: "error"; message: string };

async function uploadOneToStaging(file: File, setStep: (s: string) => void): Promise<{ path: string } | { error: string }> {
  setStep(`завантаження ${file.name}…`);
  const initRes = await fetch("/api/parent/literature-v2-import/init", {
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

export function LiteratureV2ImportPanel({ subjects }: { subjects: SubjectOption[] }) {
  const [subjectId, setSubjectId] = useState("");
  const [courseFile, setCourseFile] = useState<File | null>(null);
  const [teacherFile, setTeacherFile] = useState<File | null>(null);
  const [assetsFile, setAssetsFile] = useState<File | null>(null);
  const [taskTablesFile, setTaskTablesFile] = useState<File | null>(null);
  const [illustrationsZip, setIllustrationsZip] = useState<File | null>(null);
  const [state, setState] = useState<UiState>({ status: "idle" });

  async function doImport() {
    if (!subjectId) return setState({ status: "error", message: "Оберіть предмет." });
    if (!courseFile || !teacherFile || !assetsFile || !taskTablesFile) {
      return setState({ status: "error", message: "Потрібні всі чотири файли: course.json, teacher.json, assets.json, task_tables.json." });
    }
    for (const f of [courseFile, teacherFile, assetsFile, taskTablesFile, illustrationsZip]) {
      if (f && f.size > MAX_COURSE_ZIP_BYTES) return setState({ status: "error", message: `Файл ${f.name} завеликий.` });
    }

    let step = "";
    setState({ status: "uploading", step });
    const setStep = (s: string) => {
      step = s;
      setState({ status: "uploading", step: s });
    };

    const course = await uploadOneToStaging(courseFile, setStep);
    if ("error" in course) return setState({ status: "error", message: course.error });
    const teacher = await uploadOneToStaging(teacherFile, setStep);
    if ("error" in teacher) return setState({ status: "error", message: teacher.error });
    const assets = await uploadOneToStaging(assetsFile, setStep);
    if ("error" in assets) return setState({ status: "error", message: assets.error });
    const taskTables = await uploadOneToStaging(taskTablesFile, setStep);
    if ("error" in taskTables) return setState({ status: "error", message: taskTables.error });
    let illustrationsZipPath: string | undefined;
    if (illustrationsZip) {
      const zip = await uploadOneToStaging(illustrationsZip, setStep);
      if ("error" in zip) return setState({ status: "error", message: zip.error });
      illustrationsZipPath = zip.path;
    }

    setState({ status: "processing" });
    const result = await importLiteratureV2Action({
      subjectId,
      courseStoragePath: course.path,
      teacherStoragePath: teacher.path,
      assetsStoragePath: assets.path,
      taskTablesStoragePath: taskTables.path,
      illustrationsZipStoragePath: illustrationsZipPath,
    });
    if (result.status === "ok") setState({ status: "done", summary: result.summary });
    else setState({ status: "error", message: result.message });
  }

  const busy = state.status === "uploading" || state.status === "processing";

  return (
    <div className="flex flex-col gap-3.5">
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

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">public/course.json</span>
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => setCourseFile(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">private/teacher.json</span>
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => setTeacherFile(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">catalog/assets.json</span>
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => setAssetsFile(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">catalog/task_tables.json</span>
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => setTaskTablesFile(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">Ілюстрації (необов&apos;язково): zip з папкою assets/</span>
        <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => setIllustrationsZip(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>

      <button type="button" disabled={busy} onClick={() => void withBusySignal(doImport)} className={parentButton}>
        {state.status === "uploading" ? state.step : state.status === "processing" ? "Обробка…" : "📤 Імпортувати"}
      </button>

      {state.status === "error" && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {state.message}
        </p>
      )}
      {state.status === "done" && <LiteratureV2ImportResult summary={state.summary} />}
    </div>
  );
}

function LiteratureV2ImportResult({ summary }: { summary: LiteratureV2ImportSummary }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-p-line bg-p-bg p-3.5">
      <p role="status" className="text-[13px] font-bold text-p-success">
        Імпортовано {summary.lessonsImported} уроків, {summary.screensImported} екранів, {summary.tasksImported} завдань, {summary.taskTablesImported} таблиць.
      </p>
      <p className="text-xs text-p-muted">
        {summary.packageTitle} · {summary.subjectName} · ключів із підказками: {summary.taskKeysImported} · ілюстрацій завантажено: {summary.assetsUploaded}
      </p>
      {summary.assetsMissing.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px] font-bold text-p-text">Ілюстрації без файлу ({summary.assetsMissing.length})</summary>
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
