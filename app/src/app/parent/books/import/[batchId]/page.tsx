import Link from "next/link";
import { notFound } from "next/navigation";
import { ManualImportConfirmForm } from "@/components/parent/books/ManualImportConfirmForm";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { getManualImportBatch, listSubjects } from "@/server/books/queries";
import type { FolderCommitResult, StoredPlan } from "@/server/ingest/manual-batch-pipeline";
import { PageTitle, Panel } from "../../../ui";

export const maxDuration = 300;

/** ADR-031 §3.8: confirm/edit per-folder subject mapping (step 2) -> "Імпортувати" (step 3), or the result report once `status = 'done'`. */
export default async function ManualImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const { familyId } = await requireParentAccess();
  const batch = await getManualImportBatch(familyId, batchId);
  if (!batch) notFound();
  const t = uk.parent.manualImport;
  const plan = batch.plan as StoredPlan | null;

  return (
    <>
      <PageTitle
        action={
          <Link href="/parent/books/import" className="inline-flex min-h-11 items-center text-[13px] font-bold text-p-primary">
            {t.back} ▸
          </Link>
        }
      >
        {batch.name}
      </PageTitle>
      {batch.status === "error" && (
        <Panel>
          <p className="text-[13px] font-bold text-p-danger">{(batch.errorDetail && t.errorDetail[batch.errorDetail]) ?? batch.errorDetail ?? uk.common.error}</p>
        </Panel>
      )}
      {batch.status === "importing" && (
        <Panel>
          <p className="text-[13px] text-p-muted">{t.status.importing}</p>
        </Panel>
      )}
      {batch.status === "pending_review" && plan?.form === "batch" && (
        <Panel title={t.confirm.title}>
          <ManualImportConfirmForm batchId={batch.id} folders={plan.folders} subjects={await listSubjects(familyId)} />
        </Panel>
      )}
      {batch.status === "done" && plan?.form === "batch" && (
        <Panel title={t.report.title}>
          <ul className="flex flex-col gap-2">
            {((plan as StoredPlan & { report?: FolderCommitResult[] }).report ?? []).map((r) => (
              <li key={r.slug} className="rounded-xl border border-p-line px-3.5 py-3 text-[13px]">
                <div className="font-bold">{r.slug}</div>
                <p className="mt-0.5">
                  {r.outcome === "imported" && t.report.imported(r.topicsImported ?? 0)}
                  {r.outcome === "rejected_scan" && t.report.rejected_scan}
                  {r.outcome === "skipped_by_parent" && t.report.skipped_by_parent}
                  {r.outcome === "already_imported" && t.report.already_imported}
                  {r.outcome === "error" && `${t.report.error}${r.errorDetail ? ` (${r.errorDetail})` : ""}`}
                  {r.outcome === "imported" && t.report.needsReview(r.needsReviewCount ?? 0)}
                  {r.outcome === "imported" && t.report.imageOnlySkipped(r.imageOnlyCount ?? 0)}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
