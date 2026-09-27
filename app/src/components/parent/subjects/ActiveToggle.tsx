"use client";

import { useActionState } from "react";
import { idleState, type FormState } from "@/app/actions/state";

/**
 * Generic active/inactive switch (US-22.1 КП-5, US-22.2 КП-6, US-22.3 КП-3):
 * shared by a school subject card, a course card and a course-group card —
 * all three write to the same shape of RPC (`set_subject_active` or
 * `set_course_group_active`), only the wording and the hidden id field name
 * differ.
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
  const [, formAction, pending] = useActionState(action, idleState);
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
    </form>
  );
}
