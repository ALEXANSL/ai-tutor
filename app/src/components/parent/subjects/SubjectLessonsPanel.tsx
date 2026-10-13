"use client";

import { useState } from "react";
import { deleteLessonAction, toggleLessonStatusAction } from "@/app/actions/content-admin";
import { withBusySignal } from "@/lib/busy-signal";
import { uk } from "@/i18n/uk";

export interface SubjectLessonRow {
  system: "literature" | "course" | "course_v2" | "literature_v2";
  id: string;
  title: string;
  status: string;
  printedPageFrom: number | null;
  printedPageTo: number | null;
  hasProgress: boolean;
}

/**
 * US-29.3: per-lesson on/off switch (reversible, КП-1) and permanent delete
 * (only when the lesson has no recorded child progress, КП-2). Pure client
 * state refresh after each action — no page reload needed.
 */
export function SubjectLessonsPanel({ initialLessons }: { initialLessons: SubjectLessonRow[] }) {
  const t = uk.parent.contentAdmin.lessons;
  const [lessons, setLessons] = useState(initialLessons);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(row: SubjectLessonRow) {
    setError(null);
    setBusyId(row.id);
    const enabled = row.status !== "active";
    const result = await withBusySignal(() => toggleLessonStatusAction(row.system, row.id, enabled));
    setBusyId(null);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    setLessons((prev) => prev.map((l) => (l.id === row.id ? { ...l, status: enabled ? "active" : "disabled" } : l)));
  }

  async function remove(row: SubjectLessonRow) {
    if (!window.confirm(t.deleteConfirm)) return;
    setError(null);
    setBusyId(row.id);
    const result = await withBusySignal(() => deleteLessonAction(row.system, row.id));
    setBusyId(null);
    if (result.status === "blocked") {
      setError(result.message);
      return;
    }
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    setLessons((prev) => prev.filter((l) => l.id !== row.id));
  }

  if (lessons.length === 0) return <p className="text-[13px] text-p-muted">{t.empty}</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-p-muted">{t.hint}</p>
      {error && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {error}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-p-line rounded-xl border border-p-line">
        {lessons.map((row) => {
          const isOn = row.status === "active";
          const isArchived = row.status === "archived";
          const busy = busyId === row.id;
          return (
            <li key={`${row.system}-${row.id}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
              <span className="shrink-0 rounded-full bg-p-bg px-2 py-0.5 text-[10.5px] font-extrabold text-p-muted">{t.systemLabel[row.system]}</span>
              <span className="min-w-0 flex-1 truncate font-bold">{row.title}</span>
              {row.printedPageFrom != null && <span className="shrink-0 text-[11.5px] text-p-muted">с. {row.printedPageFrom}{row.printedPageTo && row.printedPageTo !== row.printedPageFrom ? `–${row.printedPageTo}` : ""}</span>}
              <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-extrabold ${isOn ? "bg-p-success/15 text-p-success" : "bg-p-line text-p-muted"}`}>
                {t.statusBadge[row.status] ?? row.status}
              </span>
              {!isArchived && (
                <label className="flex shrink-0 items-center gap-1.5">
                  <input type="checkbox" checked={isOn} disabled={busy} onChange={() => toggle(row)} className="h-[18px] w-[18px]" />
                  <span className="text-[11.5px] font-bold">{isOn ? t.disable : t.enable}</span>
                </label>
              )}
              {!isArchived && (
                <button
                  type="button"
                  onClick={() => remove(row)}
                  disabled={busy || row.hasProgress}
                  title={row.hasProgress ? t.deleteBlockedHasProgress : undefined}
                  className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] font-bold text-p-danger disabled:cursor-not-allowed disabled:text-p-muted"
                >
                  {t.delete}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
