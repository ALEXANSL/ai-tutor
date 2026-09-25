import Link from "next/link";
import { uk } from "@/i18n/uk";
import type { LibraryCard } from "@/server/lessons/library";

/**
 * US-6.10, DoD п.11: every generated block of the topic, its review status
 * (M-10) and the child's aggregated feedback (M-13) — the passport itself
 * opens on its own page (`/parent/library/[id]`), never shown to the child.
 */
export function LibraryCardsList({ cards }: { cards: LibraryCard[] }) {
  const t = uk.parent.subjects.library;
  if (cards.length === 0) return <p className="text-[13px] text-p-muted">{t.empty}</p>;

  return (
    <ul className="grid gap-2.5">
      {cards.map((c) => (
        <li key={c.id} className="rounded-xl border border-p-line bg-p-bg px-3.5 py-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[14px] font-bold text-p-text">{c.title}</span>
            <StatusBadge status={c.status} />
          </div>
          {c.pedagogy && (
            <p className="mb-1.5 text-[12px] text-p-muted">
              {t.reviewStatus[c.pedagogy.reviewStatus]}
              {c.childFeedback.interesting + c.childFeedback.normal + c.childFeedback.boring > 0 &&
                ` · ${t.childFeedback}: ${c.childFeedback.interesting}🤩 ${c.childFeedback.normal}🙂 ${c.childFeedback.boring}😐`}
            </p>
          )}
          <Link href={`/parent/library/${c.id}`} className="text-[13px] font-bold text-p-primary">
            {t.open}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({ status }: { status: string }) {
  const t = uk.parent.subjects.library;
  const label = t.status[status as keyof typeof t.status] ?? status;
  const color = status === "needs_review" ? "bg-p-danger/15 text-p-danger" : status === "active" ? "bg-p-success/15 text-p-success" : "bg-p-muted/15 text-p-muted";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${color}`}>{label}</span>;
}
