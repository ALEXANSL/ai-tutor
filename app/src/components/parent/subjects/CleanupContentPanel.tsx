"use client";

import { useState } from "react";
import { confirmSubjectCleanupAction, previewSubjectCleanupAction } from "@/app/actions/content-admin";
import { withBusySignal } from "@/lib/busy-signal";
import { uk } from "@/i18n/uk";

interface Preview {
  lessonsCount: number;
  topicsCount: number;
  tasksCount: number;
  hasChildProgress: boolean;
}

/**
 * US-29.1 (CLAUDE.md — irreversible action): two explicit confirmation
 * steps, never a single click. Step 1 shows the exact preview (КП-1); step
 * 2 restates the exact numbers as a plain sentence the parent must
 * explicitly confirm (КП-2/КП-3) before `confirmSubjectCleanupAction`
 * actually archives anything (never deletes — ВП-76).
 */
export function CleanupContentPanel({ subjectId }: { subjectId: string }) {
  const t = uk.parent.contentAdmin.cleanup;
  const [step, setStep] = useState<"idle" | "preview" | "confirm">("idle");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function openPreview() {
    setError(null);
    setDone(null);
    setLoading(true);
    const result = await previewSubjectCleanupAction(subjectId);
    setLoading(false);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    setPreview(result);
    setStep("preview");
  }

  async function confirmArchive() {
    setConfirming(true);
    const result = await withBusySignal(() => confirmSubjectCleanupAction(subjectId));
    setConfirming(false);
    if (result.status === "error") {
      setError(result.message);
      setStep("idle");
      return;
    }
    setStep("idle");
    setPreview(null);
    setDone(t.done(result.lessonsArchived, result.topicsArchived));
  }

  function cancel() {
    setStep("idle");
    setPreview(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-p-muted">{t.hint}</p>
      <button
        type="button"
        onClick={openPreview}
        disabled={loading}
        className="inline-flex min-h-11 items-center justify-center self-start rounded-xl border border-p-danger/40 bg-p-danger/10 px-4 text-[13.5px] font-bold text-p-danger disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? t.loading : t.button}
      </button>

      {error && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-[13px] font-bold text-p-success">
          {done}
        </p>
      )}

      {(step === "preview" || step === "confirm") && preview && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/55 p-5" role="dialog" aria-modal="true" aria-label={t.previewTitle}>
          <div className="w-full max-w-[480px] rounded-[20px] bg-p-surface p-6 shadow-2xl">
            {step === "preview" ? (
              <>
                <h2 className="mb-1 text-[19px] font-extrabold">{t.previewTitle}</h2>
                {preview.lessonsCount === 0 && preview.topicsCount === 0 ? (
                  <p className="mb-4 text-[13px] text-p-muted">{t.noneToClean}</p>
                ) : (
                  <div className="mb-4 flex flex-col gap-2.5">
                    <Row label={t.rowLessons} value={String(preview.lessonsCount)} />
                    <Row label={t.rowTopics} value={String(preview.topicsCount)} />
                    <Row label={t.rowTasks} value={String(preview.tasksCount)} />
                  </div>
                )}
                {preview.hasChildProgress && <p className="mb-3.5 rounded-xl bg-p-warn/15 px-3 py-2.5 text-[12.5px] font-bold text-p-warn">{t.progressWarning}</p>}
                <p className="mb-4 text-[12.5px] text-p-muted">{t.irreversibleNote}</p>
                <div className="flex justify-end gap-2.5">
                  <button type="button" onClick={cancel} className="min-h-11 rounded-xl bg-p-bg px-4 text-[13.5px] font-bold text-p-text">
                    {t.cancel}
                  </button>
                  {(preview.lessonsCount > 0 || preview.topicsCount > 0) && (
                    <button type="button" onClick={() => setStep("confirm")} className="min-h-11 rounded-xl bg-p-danger px-4 text-[13.5px] font-bold text-white">
                      {t.continueButton}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h2 className="mb-1 text-[19px] font-extrabold">{t.confirmTitle}</h2>
                <p className="mb-5 rounded-xl bg-p-danger/10 px-3 py-3 text-[14px] font-bold text-p-danger">{t.confirmPhrase(preview.lessonsCount, preview.topicsCount)}</p>
                <div className="flex justify-end gap-2.5">
                  <button type="button" onClick={cancel} disabled={confirming} className="min-h-11 rounded-xl bg-p-bg px-4 text-[13.5px] font-bold text-p-text">
                    {t.cancel}
                  </button>
                  <button
                    type="button"
                    onClick={confirmArchive}
                    disabled={confirming}
                    className="min-h-11 rounded-xl bg-p-danger px-4 text-[13.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {confirming ? t.confirming : t.confirmPhrase(preview.lessonsCount, preview.topicsCount)}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-p-bg px-3 py-2.5 text-[13.5px]">
      <span>{label}</span>
      <b className="text-[15px]">{value}</b>
    </div>
  );
}
