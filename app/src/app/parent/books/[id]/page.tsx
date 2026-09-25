import Link from "next/link";
import { notFound } from "next/navigation";
import { reindexAction } from "@/app/actions/books";
import { BookSettingsForm, TopicEditForm, TopicLinksForm } from "@/components/parent/books/BookForms";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { kindOptions } from "@/server/books/kinds";
import { getBook, listSubjects, listTextbookTopics } from "@/server/books/queries";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { PageTitle, Panel } from "../../ui";

export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One book: type/subject, structure "розділ → тема → сторінки" with manual fixes, topic links (US-2.2, US-2.6). */
export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { familyId } = await requireParentAccess();
  if (!UUID.test(id)) notFound();
  const [book, subjects, topics, timeZone] = await Promise.all([
    getBook(familyId, id),
    listSubjects(familyId),
    listTextbookTopics(familyId),
    getFamilyTimezone(forFamily(familyId)),
  ]);
  if (!book) notFound();
  const kinds = kindOptions();
  const t = uk.parent.books;
  const d = t.detail;
  const isTextbook = book.kind === "textbook";
  const dateFmt = new Intl.DateTimeFormat("uk-UA", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const busy = book.status === "queued" || book.status === "indexing";

  return (
    <>
      <Link href="/parent/books" className="mb-2 inline-flex min-h-11 items-center text-[13px] font-bold text-p-primary">
        {d.back}
      </Link>
      <PageTitle
        action={
          <form action={reindexAction}>
            <input type="hidden" name="materialId" value={book.id} />
            <button type="submit" disabled={busy} className="min-h-11 rounded-xl border border-p-line px-3.5 text-[13px] font-bold disabled:opacity-60">
              🔄 {t.reindex}
            </button>
          </form>
        }
      >
        {book.title ?? book.name}
      </PageTitle>

      <div className="grid gap-4 min-[980px]:grid-cols-[1.4fr_1fr]">
        <Panel title={d.settings}>
          <BookSettingsForm
            materialId={book.id}
            kind={book.kind}
            subjectId={book.subjectId}
            provenance={book.provenance}
            kinds={kinds}
            subjects={subjects}
          />
        </Panel>
        <Panel title={d.info}>
          <dl className="text-[13px]">
            {[
              [d.driveName, book.name],
              [t.col.status, `${t.status[book.status] ?? book.status}${book.statusDetail && t.details[book.statusDetail] ? ` — ${t.details[book.statusDetail]}` : ""}`],
              [d.pagesLabel, book.pageCount ? t.pages(book.pageCount, book.format === "epub") : "—"],
              [d.grade, book.grade ? String(book.grade) : "—"],
              [d.cost, book.costUsd > 0 ? t.cost(book.costUsd.toFixed(3)) : "—"],
              [d.indexedAt, book.indexedAt ? dateFmt.format(new Date(book.indexedAt)) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-p-line py-2.5 last:border-b-0">
                <dt className="text-p-muted">{k}</dt>
                <dd className="text-right font-semibold break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <Panel title={d.structure}>
        {book.sections.length === 0 ? (
          <p className="text-[13px] text-p-muted">{d.structureEmpty}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {book.sections.map((s) => (
              <li key={s.id}>
                <p className="text-[14px] font-bold">
                  {s.title}{" "}
                  {s.pageFrom && (
                    <span className="font-normal text-p-muted">
                      ({t.search.page(s.pageFrom)}
                      {s.pageTo && s.pageTo !== s.pageFrom ? `–${s.pageTo}` : ""})
                    </span>
                  )}
                </p>
                {s.topics.length > 0 && (
                  <ul className="mt-1 ml-3 border-l-2 border-p-line pl-3">
                    {s.topics.map((tp) => (
                      <TopicEditForm key={tp.id} topic={tp} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {!isTextbook && (
        <Panel title={d.linksTitle}>
          <p className="-mt-2 mb-3 text-xs text-p-muted">{d.linksHint}</p>
          <TopicLinksForm
            materialId={book.id}
            topics={topics.filter((tp) => !book.sections.some((s) => s.topics.some((x) => x.id === tp.id)))}
            subjects={subjects}
            linked={book.linkedTopicIds}
          />
        </Panel>
      )}
    </>
  );
}
