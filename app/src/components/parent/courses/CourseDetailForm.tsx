"use client";

import { useActionState } from "react";
import { updateCourseAction } from "@/app/actions/subjects";
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

/** US-22.2 КП-4, US-22.3 КП-2: rename a course and (re)assign it to a group. */
export function CourseDetailForm({
  subjectId,
  name,
  groupId,
  groups,
}: {
  subjectId: string;
  name: string;
  groupId: string | null;
  groups: CourseGroupOverviewItem[];
}) {
  const [state, action, pending] = useActionState(updateCourseAction, idleState);
  const t = uk.parent.courses.detail;
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="subjectId" value={subjectId} />
      <label htmlFor="course-name" className="mb-1.5 block text-xs font-bold uppercase text-p-muted">
        {t.renameTitle}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="course-name"
          name="name"
          required
          maxLength={120}
          defaultValue={name}
          className="min-h-11 min-w-52 flex-1 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
        />
        <select
          id="course-group"
          name="groupId"
          aria-label={uk.parent.courses.groupLabel}
          defaultValue={groupId ?? ""}
          className="min-h-11 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
        >
          <option value="">{uk.parent.courses.noGroup}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60">
          {t.submit}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}
