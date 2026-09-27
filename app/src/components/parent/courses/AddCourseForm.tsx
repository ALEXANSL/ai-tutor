"use client";

import { useActionState, useEffect, useRef } from "react";
import { addCourseAction } from "@/app/actions/subjects";
import { idleState, type FormState } from "@/app/actions/state";
import { uk } from "@/i18n/uk";
import type { CourseGroupOverviewItem } from "@/server/subjects/queries";

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>
      {state.message}
    </p>
  );
}

/** US-22.2 КП-1: add a new course (a SEPARATE list from "Предмети", not the same form). */
export function AddCourseForm({ groups }: { groups: CourseGroupOverviewItem[] }) {
  const [state, action, pending] = useActionState(addCourseAction, idleState);
  const formRef = useRef<HTMLFormElement>(null);
  const t = uk.parent.courses.add;
  useEffect(() => {
    if (state.status === "ok") formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={action} className="mb-4 flex flex-col gap-2 rounded-2xl border border-p-line bg-p-surface p-3.5">
      <label htmlFor="add-course-name" className="text-xs font-bold uppercase text-p-muted">
        {t.title}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="add-course-name"
          name="name"
          required
          maxLength={120}
          placeholder={t.namePlaceholder}
          className="min-h-11 min-w-52 flex-1 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
        />
        {groups.length > 0 && (
          <select
            name="groupId"
            aria-label={t.groupLabel}
            defaultValue=""
            className="min-h-11 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
          >
            <option value="">{t.noGroupOption}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60">
          {t.submit}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}
