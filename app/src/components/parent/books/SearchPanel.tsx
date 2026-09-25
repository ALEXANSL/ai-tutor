"use client";

import { useActionState } from "react";
import { searchBooksAction, type SearchState } from "@/app/actions/books";
import { uk } from "@/i18n/uk";
import type { SubjectOption } from "@/server/books/queries";
import type { KindOption } from "./BooksList";

const control =
  "min-h-11 rounded-xl border border-p-line bg-p-bg px-3 text-[14px] text-p-text outline-none focus:border-p-primary";
const initial: SearchState = { status: "idle" };

/** "Перевірити пошук по матеріалах" (mockup 17; US-2.3 KP-1, US-2.6 KP-2). */
export function SearchPanel({ subjects, kinds }: { subjects: SubjectOption[]; kinds: KindOption[] }) {
  const [state, action, pending] = useActionState(searchBooksAction, initial);
  const t = uk.parent.books.search;
  const kindBy = new Map(kinds.map((k) => [k.key, k]));
  return (
    <section className="mb-4 rounded-2xl border border-p-line bg-p-surface px-5 py-4.5">
      <h2 className="mb-3.5 text-[15px] font-semibold">{t.title}</h2>
      <form action={action} className="flex flex-wrap gap-2">
        <input
          name="q"
          type="search"
          required
          maxLength={200}
          defaultValue={state.query ?? ""}
          placeholder={t.placeholder}
          aria-label={t.title}
          className={`${control} min-w-48 flex-1`}
        />
        <select name="kind" aria-label={uk.parent.books.allTypes} className={control} defaultValue="">
          <option value="">{uk.parent.books.allTypes}</option>
          {kinds.map((k) => (
            <option key={k.key} value={k.key}>
              {k.title}
            </option>
          ))}
        </select>
        <select name="subjectId" aria-label={uk.parent.books.allSubjects} className={control} defaultValue="">
          <option value="">{uk.parent.books.allSubjects}</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-p-primary px-4.5 text-[14px] font-bold text-white disabled:opacity-60">
          {t.submit}
        </button>
      </form>
      <div aria-live="polite">
        {state.status === "error" && <p className="mt-3 text-[13px] font-bold text-p-danger">{t.failed}</p>}
        {state.status === "ok" && state.mode === "text_only" && <p className="mt-3 text-xs text-p-muted">{t.textOnly}</p>}
        {state.status === "ok" && state.hits?.length === 0 && <p className="mt-3 text-[13px] text-p-muted">{t.none}</p>}
        {state.hits?.map((h) => (
          <article key={h.chunkId} className="mt-2.5 rounded-xl bg-p-bg px-3.5 py-3 text-[13px]">
            <p className="font-semibold">{h.snippet}</p>
            <p className="mt-1 text-[11px] text-p-muted">
              {kindBy.get(h.materialKind)?.icon ?? "📄"} {h.materialTitle ?? h.materialName} · {kindBy.get(h.materialKind)?.title ?? h.materialKind}
              {h.topicTitle ? ` · ${h.topicTitle}` : h.sectionTitle ? ` · ${h.sectionTitle}` : ""}
              {h.locator ? ` · ${h.locator}` : h.page ? `, ${t.page(h.page)}` : ""}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
