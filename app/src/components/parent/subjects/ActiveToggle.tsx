"use client";

import { useActionState } from "react";
import { idleState, type FormState } from "@/app/actions/state";

/**
 * Generic active/inactive switch (US-22.1 КП-5, US-22.2 КП-6, US-22.3 КП-3):
 * shared by a school subject card, a course card and a course-group card —
 * each action enforces its own family-scoped server write; errors remain
 * visible beside the control.
 */
export function ActiveToggle({
  action,
  idFieldName,
  id,
  active,
  labels,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  idFieldName: string;
  id: string;
  active: boolean;
  labels: { activate: string; deactivate: string };
}) {
  const [state, formAction, pending] = useActionState(action, idleState);
  return (
    <form action={formAction}>
      <input type="hidden" name={idFieldName} value={id} />
      <input type="hidden" name="active" value={(!active).toString()} />
      <button
        type="submit"
        disabled={pending}
        className={`min-h-9 rounded-full px-3 text-[12px] font-bold disabled:opacity-60 ${
          active ? "border border-p-danger text-p-danger" : "bg-p-success text-white"
        }`}
      >
        {active ? labels.deactivate : labels.activate}
      </button>
      {state.status === "error" && <p role="alert" className="mt-1 max-w-64 text-xs text-p-danger">{state.message}</p>}
    </form>
  );
}
