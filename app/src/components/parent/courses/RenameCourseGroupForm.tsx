"use client";

import { useActionState } from "react";
import { renameCourseGroupAction } from "@/app/actions/subjects";
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

/** US-22.3 КП-1: rename a course group (same duplicate check as adding one). */
export function RenameCourseGroupForm({ groupId, name }: { groupId: string; name: string }) {
  const [state, action, pending] = useActionState(renameCourseGroupAction, idleState);
  const t = uk.parent.courseGroups.rename;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="groupId" value={groupId} />
      <input
        name="name"
        required
        maxLength={120}
        defaultValue={name}
        aria-label={name}
        className="min-h-9 min-w-40 flex-1 rounded-xl border border-p-line bg-p-bg px-3 text-[13px] text-p-text outline-none focus:border-p-primary"
      />
      <button type="submit" disabled={pending} className="min-h-9 rounded-xl bg-p-primary px-3 text-[12px] font-bold text-white disabled:opacity-60">
        {t.submit}
      </button>
      <Message state={state} />
    </form>
  );
}
