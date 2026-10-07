"use client";

import { useState } from "react";
import { importMathCourseV2Action, type MathCourseV2ImportSummary } from "@/app/actions/math-course-v2";
import { withBusySignal } from "@/lib/busy-signal";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";
import type { SubjectOption } from "@/server/books/queries";
import { parentButton, parentInput } from "@/app/parent/ui";

/**
 * S35 ($0 math course-package v2 import, PO instruction 2026-10-07) — a
 * SEPARATE panel from `MaterialsImportPanel.tsx` (S34's "Книга/уроки"), for
 * the real Істер math6-part1 package's DIFFERENT contract: two JSON files
 * (`public/course.json` + `private/teacher.json`), not one zip, plus an
 * OPTIONAL third zip for the 35 supporting figures (`assets/figures/*`).
 * Kept as its own panel rather than a third option inside the existing
 * category dropdown — that dropdown's "Книга/уроки" already means
 * specifically the S34 image-anchored zip contract; overloading it with a
 * same-looking but differently-shaped upload (3 files instead of 1, a
 * course_id cross-check between two of them) would make that panel's
 * already-long `uploadCoursePackage` harder to follow for no shared code.
 */

type UiState =
  | { status: "idle" }
  | { status: "uploading"; step: string }
  | { status: "processing" }
  | { status: "done"; summary: MathCourseV2ImportSummary }
  | { status: "error"; message: string };

async function uploadOneToStaging(file: File, setStep: (s: string) => void): Promise<{ path: string } | { error: string }> {
  setStep(`завантаження ${file.name}…`);
  const initRes = await fetch("/api/parent/math-course-v2-import/init", {
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

export function MathCourseV2ImportPanel({ subjects }: { subjects: SubjectOption[] }) {
  const [subjectId, setSubjectId] = useState("");
  const [publicFile, setPublicFile] = useState<File | null>(null);
  const [privateFile, setPrivateFile] = useState<File | null>(null);
  const [assetsZip, setAssetsZip] = useState<File | null>(null);
  const [state, setState] = useState<UiState>({ status: "idle" });

  async function doImport() {
    if (!subjectId) return setState({ status: "error", message: "Оберіть предмет." });
    if (!publicFile || !privateFile) return setState({ status: "error", message: "Потрібні обидва файли: public/course.json і private/teacher.json." });
    for (const f of [publicFile, privateFile, assetsZip]) {
      if (f && f.size > MAX_COURSE_ZIP_BYTES) return setState({ status: "error", message: `Файл ${f.name} завеликий.` });
    }

    let step = "";
    setState({ status: "uploading", step });
    const setStep = (s: string) => {
      step = s;
      setState({ status: "uploading", step: s });
    };

    const pub = await uploadOneToStaging(publicFile, setStep);
    if ("error" in pub) return setState({ status: "error", message: pub.error });
    const priv = await uploadOneToStaging(privateFile, setStep);
    if ("error" in priv) return setState({ status: "error", message: priv.error });
    let assetsZipPath: string | undefined;
    if (assetsZip) {
      const assets = await uploadOneToStaging(assetsZip, setStep);
      if ("error" in assets) return setState({ status: "error", message: assets.error });
      assetsZipPath = assets.path;
    }

    setState({ status: "processing" });
    const result = await importMathCourseV2Action({ subjectId, publicStoragePath: pub.path, privateStoragePath: priv.path, assetsZipStoragePath: assetsZipPath });
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
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => setPublicFile(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">private/teacher.json</span>
        <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => setPrivateFile(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-bold text-p-text">Рисунки (необов&apos;язково): zip з папкою assets/</span>
        <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => setAssetsZip(e.target.files?.[0] ?? null)} className={parentInput} />
      </label>

      <button type="button" disabled={busy} onClick={() => void withBusySignal(doImport)} className={parentButton}>
        {state.status === "uploading" ? state.step : state.status === "processing" ? "Обробка…" : "📤 Імпортувати"}
      </button>

      {state.status === "error" && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {state.message}
        </p>
      )}
      {state.status === "done" && <MathCourseV2ImportResult summary={state.summary} />}
    </div>
  );
}

function MathCourseV2ImportResult({ summary }: { summary: MathCourseV2ImportSummary }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-p-line bg-p-bg p-3.5">
      <p role="status" className="text-[13px] font-bold text-p-success">
        Імпортовано {summary.lessonsImported} уроків, {summary.screensImported} екранів, {summary.questionsImported} питань, {summary.exercisesImported} вправ.
      </p>
      <p className="text-xs text-p-muted">
        {summary.packageTitle} · {summary.subjectName} · рисунків завантажено: {summary.assetsUploaded}
      </p>
      {summary.assetsMissing.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px] font-bold text-p-text">Рисунки без файлу ({summary.assetsMissing.length})</summary>
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
