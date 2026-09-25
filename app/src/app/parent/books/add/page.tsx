import Link from "next/link";
import { AddBookPanel } from "@/components/parent/books/AddBookPanel";
import { FolderAccessBanner } from "@/components/parent/books/FolderAccessBanner";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { getFolderAccessStatus, isDriveConfigured } from "@/server/drive/service";
import { PageTitle } from "../../ui";

export const maxDuration = 300;

/** Short panel opened by "➕ Додати книгу" on the dashboard (US-2.7 KP-4). */
export default async function AddBookPage() {
  const { familyId } = await requireParentAccess();
  const [access, driveConfigured] = await Promise.all([getFolderAccessStatus(familyId), isDriveConfigured(familyId)]);
  const t = uk.parent.books;
  return (
    <>
      <PageTitle
        action={
          <Link href="/parent/books" className="inline-flex min-h-11 items-center text-[13px] font-bold text-p-primary">
            {t.add.back} ▸
          </Link>
        }
      >
        {t.add.title}
      </PageTitle>
      <FolderAccessBanner status={access} />
      <AddBookPanel driveConfigured={driveConfigured} />
    </>
  );
}
