"use client";

import { useActionState, useMemo, useState } from "react";
import { setCurrentTopicAction } from "@/app/actions/subjects";
import { idleState, type FormState } from "@/app/actions/state";
import { uk } from "@/i18n/uk";
import type { SubjectTopicOption } from "@/server/subjects/queries";

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>
      {state.message}
    </p>
  );
}

/**
 * US-3.1 KP-1: the parent picks the current topic from the textbook's topic
 * list, or types free text with auto-suggest — here, a filter that narrows
 * the clickable list as you type (accessible, works on tablet too).
 */
export function CurrentTopicPicker({
  subjectId,
  topics,
  currentTopicId,
}: {
  subjectId: string;
  topics: SubjectTopicOption[];
  currentTopicId: string | null;
}) {
  const [state, action, pending] = useActionState(setCurrentTopicAction, idleState);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(currentTopicId);
  const t = uk.parent.subjects.detail;

  const filtered = useMemo(() => {
    const q = filter.trim().toLocaleLowerCase("uk");
    if (!q) return topics;
    return topics.filter((tp) => tp.title.toLocaleLowerCase("uk").includes(q));
  }, [filter, topics]);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="subjectId" value={subjectId} />
      <input type="hidden" name="topicId" value={selectedId ?? ""} />
      <div>
        <label htmlFor="topic-filter" className="mb-1.5 block text-xs font-bold uppercase text-p-muted">
          {t.pickerTitle}
        </label>
        <input
          id="topic-filter"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t.filterPlaceholder}
          className="min-h-11 w-full rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary"
        />
        <p className="mt-1 text-[12px] text-p-muted">{t.pickerHint}</p>
      </div>
      <div role="radiogroup" aria-label={t.pickerTitle} className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-xl border border-p-line p-1.5">
        {filtered.length === 0 && <p className="p-2 text-[13px] text-p-muted">{t.filterEmpty}</p>}
        {filtered.map((tp) => {
          const active = tp.id === selectedId;
          return (
            <button
              type="button"
              key={tp.id}
              role="radio"
              aria-checked={active}
              onClick={() => setSelectedId(tp.id)}
              className={`flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 text-left text-[14px] ${
                active ? "bg-p-primary text-white font-bold" : "hover:bg-p-bg"
              }`}
            >
              <span>{tp.title}</span>
              {tp.pageFrom != null && (
                <span className={`shrink-0 text-[12px] ${active ? "text-white/85" : "text-p-muted"}`}>{t.pages(tp.pageFrom, tp.pageTo)}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || !selectedId}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60"
        >
          {t.save}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}
