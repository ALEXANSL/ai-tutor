"use client";

import { useEffect, useMemo, useState } from "react";
import { confirmBulkWarmupAction, estimateBulkWarmupAction, getBulkWarmupStatusAction } from "@/app/actions/subjects";
import { withBusySignal } from "@/lib/busy-signal";
import { uk } from "@/i18n/uk";

type TopicWarmStatus = "ready" | "queued" | "generating" | "error";

interface Topic {
  id: string;
  title: string;
}

interface Estimate {
  selectedCount: number;
  readyCount: number;
  neededCount: number;
  estimatedCostUsd: number;
  exceedsAwarenessThreshold: boolean;
  wouldExceedMonthlyLimit: boolean;
}

const POLL_MS = 4000;
const IN_PROGRESS: TopicWarmStatus[] = ["queued", "generating"];

const STATUS_BADGE_CLASS: Record<TopicWarmStatus, string> = {
  ready: "bg-p-success/15 text-p-success",
  queued: "bg-p-muted/15 text-p-muted",
  generating: "bg-p-primary/15 text-p-primary",
  error: "bg-p-danger/15 text-p-danger",
};

/**
 * US-22.4 (D-108, S33): checkboxes + "Обрати всі" on the subject's topic
 * list, a hard full-screen cost-confirmation overlay (CLAUDE.md — never a
 * toast) before anything is enqueued, and a per-topic status badge + summary
 * line above the list afterward — no new screen (docs/05 S33 / 12.28).
 */
export function BulkWarmupPanel({ subjectId, topics, initialStatuses }: { subjectId: string; topics: Topic[]; initialStatuses: Record<string, TopicWarmStatus> }) {
  const t = uk.parent.subjects.bulkWarmup;
  const topicIds = useMemo(() => topics.map((tp) => tp.id), [topics]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Seeded once from the server component's own render (КП-5: statuses must
  // survive a plain page reload); `confirm()` below and the polling effect
  // keep it fresh afterwards without needing a full page reload.
  const [statuses, setStatuses] = useState<Record<string, TopicWarmStatus>>(initialStatuses);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const allChecked = topics.length > 0 && selected.size === topics.length;
  const touchedIds = useMemo(() => topicIds.filter((id) => statuses[id]), [topicIds, statuses]);
  const readyTouchedCount = touchedIds.filter((id) => statuses[id] === "ready").length;

  useEffect(() => {
    const pending = touchedIds.some((id) => IN_PROGRESS.includes(statuses[id] as TopicWarmStatus));
    if (!pending) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await getBulkWarmupStatusAction(touchedIds);
      if (cancelled) return;
      if (result.status === "ok") setStatuses((prev) => ({ ...prev, ...result.statuses }));
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Re-runs whenever the set of "still in progress" ids or their statuses change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, touchedIds.join(",")]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(topicIds));
  }

  async function openConfirm() {
    setError(null);
    setNotice(null);
    setEstimating(true);
    const result = await estimateBulkWarmupAction(subjectId, Array.from(selected));
    setEstimating(false);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    setEstimate(result);
    setOverlayOpen(true);
  }

  function closeConfirm() {
    setOverlayOpen(false);
  }

  async function confirm() {
    setConfirming(true);
    const ids = Array.from(selected);
    const result = await withBusySignal(() => confirmBulkWarmupAction(subjectId, ids));
    setConfirming(false);
    if (result.status === "budget_blocked") {
      setError(result.message);
      return;
    }
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    // КП-3: every needing-prep topic in the selection is now queued —
    // reflect that immediately without waiting for the next poll tick.
    setStatuses((prev) => {
      const next = { ...prev };
      for (const id of ids) if (next[id] !== "ready") next[id] = "queued";
      return next;
    });
    setOverlayOpen(false);
    setSelected(new Set());
    setNotice(t.confirm.started);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-p-muted">{t.hint}</p>

      {touchedIds.length > 0 && (
        <p className={`text-[12px] font-bold ${readyTouchedCount < touchedIds.length ? "text-p-primary" : "text-p-success"}`}>
          {readyTouchedCount < touchedIds.length ? t.summary(readyTouchedCount, touchedIds.length) : t.summaryDone}
        </p>
      )}

      <label className="flex min-h-11 items-center gap-2 text-[13px] font-bold">
        <input type="checkbox" checked={allChecked} onChange={toggleAll} className="h-[18px] w-[18px]" />
        {t.selectAll}
      </label>

      <ul className="flex flex-col divide-y divide-p-line rounded-xl border border-p-line">
        {topics.map((tp) => {
          const status = statuses[tp.id];
          return (
            <li key={tp.id} className="flex min-h-11 items-center gap-3 px-3 py-2 text-[13px]">
              <input type="checkbox" checked={selected.has(tp.id)} onChange={() => toggleOne(tp.id)} className="h-[18px] w-[18px] shrink-0" />
              <span className="flex-1">{tp.title}</span>
              {status && (
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-extrabold ${STATUS_BADGE_CLASS[status]}`} title={status === "error" ? t.errorHint : undefined}>
                  {t.status[status]}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] font-bold text-p-muted">{t.selectedCount(selected.size)}</span>
        <button
          type="button"
          disabled={selected.size === 0 || estimating}
          onClick={openConfirm}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:cursor-not-allowed disabled:bg-p-line disabled:text-p-muted"
        >
          {estimating ? t.estimating : t.prepareButton}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-[13px] font-bold text-p-success">
          {notice}
        </p>
      )}

      {overlayOpen && estimate && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-5" role="dialog" aria-modal="true" aria-label={t.confirm.title}>
          <div className="w-full max-w-[480px] rounded-[20px] bg-p-surface p-6 shadow-2xl">
            <h2 className="mb-1 text-[19px] font-extrabold">{t.confirm.title}</h2>
            <p className="mb-4 text-[13px] text-p-muted">{t.confirm.lead}</p>

            <div className="mb-4 flex flex-col gap-2.5">
              <Row label={t.confirm.rowSelected} value={String(estimate.selectedCount)} />
              <Row label={t.confirm.rowReady} value={String(estimate.readyCount)} valueClassName="text-p-success" />
              <Row label={t.confirm.rowNeeded} value={String(estimate.neededCount)} />
            </div>

            <div className="mb-3 flex items-center justify-between rounded-xl bg-p-primary/10 px-3 py-3.5">
              <span className="text-[13px] font-bold">{t.confirm.amountLabel}</span>
              <span className="text-[22px] font-extrabold text-p-primary">{t.confirm.amount(estimate.estimatedCostUsd)}</span>
            </div>

            {estimate.exceedsAwarenessThreshold && !estimate.wouldExceedMonthlyLimit && (
              <p className="mb-3.5 rounded-xl bg-p-warn/15 px-3 py-2.5 text-[12.5px] font-bold text-p-warn">{t.confirm.awareness(estimate.estimatedCostUsd)}</p>
            )}
            {estimate.wouldExceedMonthlyLimit && <p className="mb-3.5 rounded-xl bg-p-danger/15 px-3 py-2.5 text-[12.5px] font-bold text-p-danger">{t.confirm.budgetBlocked}</p>}

            <div className="flex justify-end gap-2.5">
              <button type="button" onClick={closeConfirm} className="min-h-11 rounded-xl bg-p-bg px-4 text-[13.5px] font-bold text-p-text">
                {t.confirm.cancel}
              </button>
              {!estimate.wouldExceedMonthlyLimit && (
                <button
                  type="button"
                  onClick={confirm}
                  disabled={confirming || estimate.neededCount === 0}
                  className="min-h-11 rounded-xl bg-p-primary px-4 text-[13.5px] font-bold text-white disabled:cursor-not-allowed disabled:bg-p-line disabled:text-p-muted"
                >
                  {estimate.neededCount === 0 ? t.confirm.goButtonNone : t.confirm.goButton(estimate.neededCount, estimate.estimatedCostUsd)}
                </button>
              )}
            </div>
            <p className="mt-3.5 text-center text-[11px] text-p-muted">{t.confirm.note}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-p-bg px-3 py-2.5 text-[13.5px]">
      <span>{label}</span>
      <b className={`text-[15px] ${valueClassName ?? ""}`}>{value}</b>
    </div>
  );
}
