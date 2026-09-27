"use client";

import { useActionState } from "react";
import { renameSubjectAction } from "@/app/actions/subjects";
import { idleState, type FormState } from "@/app/actions/state";
import { uk } from "@/i18n/uk";

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>
      {state.message}
    </p>
  );
}

/** US-22.1 КП-4: rename a school subject (same duplicate check as add). */
export function RenameSubjectForm({ subjectId, name }: { subjectId: string; name: string }) {
  const [state, action, pending] = useActionState(renameSubjectAction, idleState);
  const t = uk.parent.subjects.rename;
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="subjectId" value={subjectId} />
      <label htmlFor="rename-subject-name" className="mb-1.5 block text-xs font-bold uppercase text-p-muted">
        {t.title}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="rename-subject-name"
          name="name"
          required
          maxLength={120}
          defaultValue={name}
          className="min-h-11 min-w-52 flex-1 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
        />
        <button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60">
          {t.submit}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}
