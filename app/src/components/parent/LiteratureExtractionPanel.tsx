"use client";

import { useState, useTransition } from "react";
import { runLiteratureExtractionAction, type LiteratureExtractionState } from "@/app/actions/literature-extraction";
import { uk } from "@/i18n/uk";

type Summary = Extract<LiteratureExtractionState, { status: "ok" }>["summary"];

/**
 * S33 follow-up: the parent-cabinet trigger for the new
 * `runLiteratureExtraction` path (previously CLI-only,
 * `npm run literature:extract`). Plain text fields for `materialId`/
 * `subjectId` — no book picker yet (S33's scope is "make it work for one
 * subject/book today" per `literatureExtraction.ts`'s own module doc), so
 * the PO pastes ids from his own reference list. One click, one result —
 * no dry-run/apply split here (unlike `ContentQaSweepPanel`): extraction
 * always writes its output, same as the CLI script it replaces.
 */
export function LiteratureExtractionPanel() {
  const t = uk.parent.settings.literatureExtraction;
  const [materialId, setMaterialId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [running, startRunning] = useTransition();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setSummary(null);
    startRunning(async () => {
      const result = await runLiteratureExtractionAction(materialId.trim(), subjectId.trim());
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      setSummary(result.summary);
    });
  }

  const canRun = materialId.trim().length > 0 && subjectId.trim().length > 0 && !running;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-p-muted">{t.help}</p>

      <label className="flex flex-col gap-1 text-[13px] font-bold">
        {t.materialIdLabel}
        <input
          type="text"
          value={materialId}
          onChange={(e) => setMaterialId(e.target.value)}
          disabled={running}
          className="min-h-11 rounded-xl bg-p-bg px-3 text-[14px] font-normal ring-1 ring-p-line"
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-bold">
        {t.subjectIdLabel}
        <input
          type="text"
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          disabled={running}
          className="min-h-11 rounded-xl bg-p-bg px-3 text-[14px] font-normal ring-1 ring-p-line"
        />
      </label>

      <div>
        <button
          type="button"
          disabled={!canRun}
          onClick={run}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:cursor-not-allowed disabled:bg-p-line disabled:text-p-muted"
        >
          {running ? t.running : t.runButton}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {error}
        </p>
      )}

      {summary && (
        <div role="status" className="flex flex-col gap-2 rounded-xl bg-p-bg p-3.5">
          <p className="text-[13.5px] font-extrabold">{t.resultTitle}</p>
          <p className="text-[13px]">{t.summary(summary.materialTitle, summary.subjectName, summary.groups)}</p>
          <p className="text-[13px]">{t.totals(summary.topics.length, summary.active, summary.needsReview)}</p>
          {summary.needsReview > 0 && <p className="text-[12.5px] text-p-muted">{t.needsReviewHint}</p>}
          <p className="text-[12px] text-p-muted">{t.costLabel(summary.totalCostUsd)}</p>
          {summary.driveWriteFailures.length > 0 && (
            <>
              <p className="text-[12.5px] font-bold text-p-muted">{t.driveFailuresTitle}</p>
              <ul className="flex flex-col gap-1 text-[12.5px] text-p-muted">
                {summary.driveWriteFailures.map((f) => (
                  <li key={f.topicNo}>{t.driveFailureLine(f.topicNo, f.reason)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
