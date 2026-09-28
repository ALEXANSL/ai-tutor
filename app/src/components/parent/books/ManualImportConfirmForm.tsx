"use client";

import { useActionState, useState } from "react";
import { commitManualBatchAction } from "@/app/actions/manual-import";
import { idleState, type FormState } from "@/app/actions/state";
import { uk } from "@/i18n/uk";
import type { SubjectOption } from "@/server/books/queries";
import type { FolderPlan } from "@/server/ingest/manual-batch";

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>
      {state.message}
    </p>
  );
}

type Action = "subject" | "create_subject" | "skip";

function FolderRow({ folder, subjects }: { folder: FolderPlan; subjects: SubjectOption[] }) {
  const t = uk.parent.manualImport.confirm;
  const matchedSubject = folder.suggestedSubjectCode ? subjects.find((s) => s.code === folder.suggestedSubjectCode) : undefined;
  const [action, setAction] = useState<Action>(matchedSubject ? "subject" : "create_subject");

  if (!folder.parseOk) {
    return (
      <li className="rounded-xl border border-p-line px-3.5 py-3">
        <div className="font-bold">{folder.slug}</div>
        <p className="mt-1 text-[13px] text-p-danger">{t.parseError}</p>
      </li>
    );
  }
  if (folder.wholeFolderRejected) {
    return (
      <li className="rounded-xl border border-p-line px-3.5 py-3 opacity-70">
        <div className="font-bold">{folder.slug}</div>
        <p className="mt-1 text-[13px] text-p-danger">{t.rejected}</p>
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-p-line px-3.5 py-3">
      <div className="font-bold">{folder.slug}</div>
      <p className="mt-0.5 text-[12px] text-p-muted">{t.folderCounts(folder.importableCount, folder.imageOnlyCount, folder.qrCount + folder.unknownStatusCount)}</p>
      {folder.needsReviewTitles.length > 0 && (
        <details className="mt-1 text-[12px] text-p-muted">
          <summary className="cursor-pointer font-semibold">{t.needsReviewTitle}</summary>
          <ul className="ml-4 list-disc">
            {folder.needsReviewTitles.map((title, i) => (
              <li key={i}>{title}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          name={`action_${folder.slug}`}
          value={action}
          onChange={(e) => setAction(e.target.value as Action)}
          className="min-h-11 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
        >
          <option value="subject">{t.subjectLabel}</option>
          <option value="create_subject">{t.createSubjectOption}</option>
          <option value="skip">{t.skipOption}</option>
        </select>
        {action === "subject" && (
          <select
            name={`subjectId_${folder.slug}`}
            defaultValue={matchedSubject?.id ?? ""}
            className="min-h-11 min-w-48 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
          >
            <option value="">{t.subjectPlaceholder}</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {action === "create_subject" && (
          <input
            name={`newSubjectName_${folder.slug}`}
            defaultValue={folder.suggestedNewSubjectName ?? folder.slug}
            maxLength={120}
            className="min-h-11 min-w-48 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
          />
        )}
      </div>
    </li>
  );
}

export function ManualImportConfirmForm({ batchId, folders, subjects }: { batchId: string; folders: FolderPlan[]; subjects: SubjectOption[] }) {
  const [state, action, pending] = useActionState(commitManualBatchAction, idleState);
  const t = uk.parent.manualImport.confirm;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="batchId" value={batchId} />
      <p className="text-[13px] text-p-muted">{t.intro}</p>
      <ul className="flex flex-col gap-2.5">
        {folders.map((f) => (
          <FolderRow key={f.slug} folder={f} subjects={subjects} />
        ))}
      </ul>
      <div>
        <button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-p-primary px-5 text-[14px] font-bold text-white disabled:opacity-60">
          {t.submit}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}
