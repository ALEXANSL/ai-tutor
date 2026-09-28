import Link from "next/link";
import { ManualImportBatchesList } from "@/components/parent/books/ManualImportBatchesList";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listManualImportBatches } from "@/server/books/queries";
import { PageTitle, Panel } from "../../ui";

export const maxDuration = 300;

/** ADR-031 §3.8: ZIP batches ("Розібрати архів" -> confirm mapping -> "Імпортувати") detected by the same Drive folder scan as "Мої книги". */
export default async function ManualImportPage() {
  const { familyId } = await requireParentAccess();
  const batches = await listManualImportBatches(familyId);
  const t = uk.parent.manualImport;
  return (
    <>
      <PageTitle
        action={
          <Link href="/parent/books" className="inline-flex min-h-11 items-center text-[13px] font-bold text-p-primary">
            {t.back} ▸
          </Link>
        }
      >
        {t.title}
      </PageTitle>
      <Panel>
        <p className="-mt-1 mb-3.5 text-xs text-p-muted">{t.listDesc}</p>
        <ManualImportBatchesList initial={batches} />
      </Panel>
    </>
  );
}
