"use client";

import { useRef, useState } from "react";
import { importLiteratureCourseAction, type LiteratureImportState } from "@/app/actions/literature-import";
import type { LiteratureCandidateMaterial } from "@/app/actions/literature-extraction";
import { uk } from "@/i18n/uk";

type Summary = Extract<LiteratureImportState, { status: "ok" }>["summary"];

/**
 * S33 follow-up ($0 manual-course importer, PO decision 2026-09-30): the
 * sibling panel to `LiteratureExtractionPanel` — same book picker (same
 * `listLiteratureCandidateMaterials` data, passed in by the settings page),
 * but a zip file input instead of a "run" button, and NO cost line (this
 * path never calls an AI model). Small text-only zip → plain `FormData`
 * upload through a server action, no resumable-upload dance needed (unlike
 * `UploadBookButton.tsx`'s PDFs/EPUBs).
 */
export function LiteratureImportPanel({ materials }: { materials: LiteratureCandidateMaterial[] }) {
  const t = uk.parent.settings.literatureImport;
  const [materialId, setMaterialId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const file = inputRef.current?.files?.[0];
    if (!materialId || !file) return;
    setError(null);
    setSummary(null);
    setImporting(true);
    try {
      const formData = new FormData();
      formData.set("materialId", materialId);
      formData.set("file", file);
      const result = await importLiteratureCourseAction(formData);
      if (result.status === "error") {
        setError(result.message);
      } else {
        setSummary(result.summary);
        if (inputRef.current) inputRef.current.value = "";
      }
    } finally {
      setImporting(false);
    }
  }

  const canRun = materialId.length > 0 && !importing;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-p-muted">{t.help}</p>

      {materials.length === 0 ? (
        <p className="text-[13px] text-p-muted">{t.noMaterials}</p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-[13px] font-bold">
            {t.materialPickerLabel}
            <select
              value={materialId}
              onChange={(e) => setMaterialId(e.target.value)}
              disabled={importing}
              className="min-h-11 rounded-xl bg-p-bg px-3 text-[14px] font-normal ring-1 ring-p-line"
            >
              <option value="">{t.materialPickerPlaceholder}</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.subjectName ? `${m.title} — ${m.subjectName}` : m.title}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[13px] font-bold">
            {t.fileLabel}
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              disabled={importing}
              className="min-h-11 rounded-xl bg-p-bg px-3 py-2 text-[13px] font-normal ring-1 ring-p-line file:mr-3 file:rounded-lg file:border-0 file:bg-p-primary file:px-3 file:py-1.5 file:text-[13px] file:font-bold file:text-white"
            />
          </label>

          <div>
            <button
              type="button"
              disabled={!canRun}
              onClick={() => void run()}
              className="inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:cursor-not-allowed disabled:bg-p-line disabled:text-p-muted"
            >
              {importing ? t.importing : t.importButton}
            </button>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {error}
        </p>
      )}

      {summary && (
        <div role="status" className="flex flex-col gap-2 rounded-xl bg-p-bg p-3.5">
          <p className="text-[13.5px] font-extrabold">{t.resultTitle}</p>
          <p className="text-[13px]">{t.summary(summary.materialTitle, summary.subjectName, summary.topics.length)}</p>
          <p className="text-[13px]">{t.totals(summary.topics.length, summary.active, summary.needsReview)}</p>
          {summary.needsReview > 0 && <p className="text-[12.5px] text-p-muted">{t.needsReviewHint}</p>}
          {summary.warnings.length > 0 && (
            <>
              <p className="text-[12.5px] font-bold text-p-muted">{t.warningsTitle}</p>
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-[12px] text-p-muted">
                {summary.warnings.map((w, i) => (
                  <li key={i}>{t.warningLine(w.topicNo, w.field, w.message)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
