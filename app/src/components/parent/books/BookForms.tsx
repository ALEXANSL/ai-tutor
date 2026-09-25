"use client";

import { useActionState, useState } from "react";
import { saveTopicLinksAction, updateBookAction, updateTopicAction } from "@/app/actions/books";
import { idleState, type FormState } from "@/app/actions/state";
import { uk } from "@/i18n/uk";
import type { SubjectOption } from "@/server/books/queries";
import type { KindOption } from "./BooksList";

const input =
  "min-h-11 w-full rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary";
const label = "mb-1.5 block text-xs font-bold text-p-muted uppercase";
const button = "inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60";

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>
      {state.message}
    </p>
  );
}

/** Type / subject / provenance of a book (US-2.6 KP-1: manual values survive re-indexing). */
export function BookSettingsForm({
  materialId,
  kind,
  subjectId,
  provenance,
  kinds,
  subjects,
}: {
  materialId: string;
  kind: string;
  subjectId: string | null;
  provenance: string | null;
  kinds: KindOption[];
  subjects: SubjectOption[];
}) {
  const [state, action, pending] = useActionState(updateBookAction, idleState);
  const t = uk.parent.books.detail;
  return (
    <form action={action} className="grid gap-3 min-[820px]:grid-cols-2">
      <input type="hidden" name="materialId" value={materialId} />
      <div>
        <label htmlFor="book-kind" className={label}>
          {t.kind}
        </label>
        <select id="book-kind" name="kind" defaultValue={kind} className={input}>
          {kinds.map((k) => (
            <option key={k.key} value={k.key}>
              {k.icon} {k.title}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="book-subject" className={label}>
          {t.subject}
        </label>
        <select id="book-subject" name="subjectId" defaultValue={subjectId ?? ""} className={input}>
          <option value="">{uk.parent.books.noSubject}</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="min-[820px]:col-span-2">
        <label htmlFor="book-provenance" className={label}>
          {t.provenance}
        </label>
        <input id="book-provenance" name="provenance" defaultValue={provenance ?? ""} maxLength={300} placeholder={t.provenanceHint} className={input} />
      </div>
      <div className="flex flex-wrap items-center gap-3 min-[820px]:col-span-2">
        <button type="submit" disabled={pending} className={button}>
          {t.save}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

/** Manual fix of one topic (US-2.2 KP-2). */
export function TopicEditForm({
  topic,
}: {
  topic: { id: string; title: string; pageFrom: number | null; pageTo: number | null; manual: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(updateTopicAction, idleState);
  const t = uk.parent.books.detail;
  const pages = topic.pageFrom ? `${uk.parent.books.search.page(topic.pageFrom)}${topic.pageTo && topic.pageTo !== topic.pageFrom ? `–${topic.pageTo}` : ""}` : "";
  return (
    <li className="border-b border-p-line py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[14px]">
          {topic.title} <span className="text-p-muted">{pages}</span>
          {topic.manual && <span className="ml-2 rounded-full bg-p-bg px-2 py-0.5 text-[11px] text-p-muted">✎ {t.manual}</span>}
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="min-h-11 text-[12px] font-bold text-p-primary">
          {t.edit}
        </button>
      </div>
      {open && (
        <form action={action} className="mt-2 grid grid-cols-[1fr_90px_90px] gap-2 max-[520px]:grid-cols-2">
          <input type="hidden" name="topicId" value={topic.id} />
          <label className="max-[520px]:col-span-2">
            <span className={label}>{t.topicTitle}</span>
            <input name="title" required maxLength={300} defaultValue={topic.title} className={input} />
          </label>
          <label>
            <span className={label}>{t.pageFrom}</span>
            <input name="pageFrom" type="number" min={1} inputMode="numeric" defaultValue={topic.pageFrom ?? ""} className={input} />
          </label>
          <label>
            <span className={label}>{t.pageTo}</span>
            <input name="pageTo" type="number" min={1} inputMode="numeric" defaultValue={topic.pageTo ?? ""} className={input} />
          </label>
          <div className="col-span-full flex flex-wrap items-center gap-3">
            <button type="submit" disabled={pending} className={button}>
              {t.saveTopic}
            </button>
            <Message state={state} />
          </div>
        </form>
      )}
    </li>
  );
}

/** Links a book to textbook topics (US-2.6 KP-1). */
export function TopicLinksForm({
  materialId,
  topics,
  subjects,
  linked,
}: {
  materialId: string;
  topics: { id: string; title: string; subjectId: string }[];
  subjects: SubjectOption[];
  linked: string[];
}) {
  const [state, action, pending] = useActionState(saveTopicLinksAction, idleState);
  const t = uk.parent.books.detail;
  if (topics.length === 0) return <p className="text-[13px] text-p-muted">{t.linksEmpty}</p>;
  const bySubject = subjects
    .map((s) => ({ subject: s, topics: topics.filter((tp) => tp.subjectId === s.id) }))
    .filter((g) => g.topics.length);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="materialId" value={materialId} />
      {bySubject.map((g) => (
        <fieldset key={g.subject.id}>
          <legend className={label}>{g.subject.name}</legend>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {g.topics.map((tp) => (
              <label key={tp.id} className="flex min-h-11 items-center gap-2 text-[14px]">
                <input type="checkbox" name="topicIds" value={tp.id} defaultChecked={linked.includes(tp.id)} className="h-5 w-5 accent-[var(--p-primary)]" />
                {tp.title}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={button}>
          {t.linksSave}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}
