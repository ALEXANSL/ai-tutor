"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { pollManualBatchesAction, previewManualBatchAction } from "@/app/actions/manual-import";
import { uk } from "@/i18n/uk";
import type { ManualImportBatchItem } from "@/server/books/queries";

const POLL_MS = 8000;
const dateFmt = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" });

function isParsed(b: ManualImportBatchItem): boolean {
  return !!b.plan && Object.keys(b.plan as object).length > 0;
}

/** ADR-031 §3.8: one row per detected ZIP — "Розібрати архів" (parse-only preview) or a link to the confirm screen once parsed. */
export function ManualImportBatchesList({ initial }: { initial: ManualImportBatchItem[] }) {
  const [batches, setBatches] = useState(initial);
  const t = uk.parent.manualImport;

  useEffect(() => {
    const needsPolling = batches.some((b) => b.status === "importing" || (b.status === "pending_review" && !isParsed(b)));
    if (!needsPolling) return;
    const id = setInterval(() => {
      pollManualBatchesAction()
        .then(setBatches)
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [batches]);

  if (batches.length === 0) return <p className="text-[13px] text-p-muted">{t.empty}</p>;

  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-left text-p-muted">
          <th className="border-b border-p-line px-2.5 py-2">{t.col.name}</th>
          <th className="border-b border-p-line px-2.5 py-2">{t.col.status}</th>
          <th className="border-b border-p-line px-2.5 py-2">{t.col.added}</th>
          <th className="border-b border-p-line px-2.5 py-2" />
        </tr>
      </thead>
      <tbody>
        {batches.map((b) => {
          const parsed = isParsed(b);
          const statusKey = b.status === "pending_review" && !parsed ? "pending_review_unparsed" : b.status;
          return (
            <tr key={b.id}>
              <td className="border-b border-p-line px-2.5 py-2.5">{b.name}</td>
              <td className="border-b border-p-line px-2.5 py-2.5">
                {t.status[statusKey] ?? b.status}
                {b.errorDetail && (
                  <div className="mt-0.5 max-w-72 text-p-muted">{t.errorDetail[b.errorDetail] ?? b.errorDetail}</div>
                )}
              </td>
              <td className="border-b border-p-line px-2.5 py-2.5 whitespace-nowrap text-p-muted">{dateFmt.format(new Date(b.createdAt))}</td>
              <td className="border-b border-p-line px-2.5 py-2.5 text-right whitespace-nowrap">
                {b.status === "pending_review" && !parsed && (
                  <form action={previewManualBatchAction}>
                    <input type="hidden" name="batchId" value={b.id} />
                    <button type="submit" className="min-h-9 rounded-xl bg-p-primary px-3 text-[13px] font-bold text-white">
                      {t.parse.button}
                    </button>
                  </form>
                )}
                {b.status === "pending_review" && parsed && (
                  <Link href={`/parent/books/import/${b.id}`} className="font-bold text-p-primary">
                    {t.open}
                  </Link>
                )}
                {b.status === "done" && (
                  <Link href={`/parent/books/import/${b.id}`} className="font-bold text-p-primary">
                    {t.open}
                  </Link>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
