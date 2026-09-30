"use client";

import { useState, useTransition } from "react";
import { runContentQaSweepAction, type ContentQaSweepState } from "@/app/actions/content-qa-sweep";
import { withBusySignal } from "@/lib/busy-signal";
import { uk } from "@/i18n/uk";

type Summary = Extract<ContentQaSweepState, { status: "ok" }>["summary"];

/**
 * ADR-034 follow-up: the parent-cabinet button for the retroactive
 * content_qa sweep (previously CLI-only, `npm run content-qa:sweep`).
 * Dry run first (`apply: false`, matches the CLI's own default) — the PO
 * sees the summary before a separate, deliberate "Застосувати" click
 * actually writes anything, mirroring the CLI's `--apply` safety gate.
 */
export function ContentQaSweepPanel() {
  const t = uk.parent.settings.maintenance;
  const [checking, startChecking] = useTransition();
  const [applying, startApplying] = useTransition();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(apply: boolean) {
    setError(null);
    const start = apply ? startApplying : startChecking;
    start(async () => {
      const result = await withBusySignal(() => runContentQaSweepAction(apply));
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      setSummary(result.summary);
    });
  }

  const pending = checking || applying;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-p-muted">{t.help}</p>

      <div className="flex flex-wrap gap-2.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(false)}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:cursor-not-allowed disabled:bg-p-line disabled:text-p-muted"
        >
          {checking ? t.checking : t.checkButton}
        </button>
        {summary && summary.totals.flagged > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(true)}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-p-bg px-4 text-[14px] font-bold text-p-text ring-1 ring-p-line disabled:cursor-not-allowed disabled:text-p-muted"
          >
            {applying ? t.applying : t.applyButton}
          </button>
        )}
      </div>
      {summary && summary.totals.flagged > 0 && summary.mode === "dry_run" && (
        <p className="text-[12px] text-p-muted">{t.applyHint}</p>
      )}

      {error && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {error}
        </p>
      )}

      {summary && (
        <div role="status" className="flex flex-col gap-2 rounded-xl bg-p-bg p-3.5">
          <p className="text-[13.5px] font-extrabold">{t.resultTitle(summary.mode)}</p>
          <p className="text-[13px]">{t.totals(summary.totals.checked, summary.totals.flagged, summary.totals.autoTransitioned)}</p>
          {summary.totals.flagged === 0 ? (
            <p className="text-[13px] font-bold text-p-success">{t.noneFlagged}</p>
          ) : (
            <>
              <p className="text-[12.5px] font-bold text-p-muted">{t.flaggedListTitle}</p>
              <ul className="flex flex-col gap-1 text-[12.5px] text-p-muted">
                {(Object.keys(summary.counts) as (keyof typeof summary.counts)[])
                  .filter((cat) => summary.counts[cat].flagged > 0)
                  .map((cat) => (
                    <li key={cat}>
                      {t.categoryLabels[cat] ?? cat}: {summary.counts[cat].flagged}
                      {summary.counts[cat].autoTransitioned > 0 ? ` (${summary.counts[cat].autoTransitioned} → «потребує перегляду»)` : ""}
                    </li>
                  ))}
              </ul>
            </>
          )}
          <p className="text-[11px] text-p-muted">{t.rerunHint}</p>
        </div>
      )}
    </div>
  );
}
