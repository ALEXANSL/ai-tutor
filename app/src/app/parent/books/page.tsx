import { AddBookPanel } from "@/components/parent/books/AddBookPanel";
import { BooksList } from "@/components/parent/books/BooksList";
import { FolderAccessBanner } from "@/components/parent/books/FolderAccessBanner";
import { SearchPanel } from "@/components/parent/books/SearchPanel";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { kindOptions } from "@/server/books/kinds";
import { listBooks, listSubjects } from "@/server/books/queries";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { getFolderAccessStatus, isDriveConfigured } from "@/server/drive/service";
import { PageTitle, Panel } from "../ui";

// Actions on this page may run background indexing via `after()` (ADR-015).
export const maxDuration = 300;

/** "Мої книги" (mockup 17; US-2.1 KP-1, 2; US-2.7 KP-1, 3, 4; US-2.3). */
export default async function BooksPage() {
  const { familyId } = await requireParentAccess();
  const [books, subjects, access, driveConfigured, timeZone] = await Promise.all([
    listBooks(familyId),
    listSubjects(familyId),
    getFolderAccessStatus(familyId),
    isDriveConfigured(familyId),
    getFamilyTimezone(forFamily(familyId)),
  ]);
  const kinds = kindOptions();
  const t = uk.parent.books;
  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <FolderAccessBanner status={access} />
      <Panel title={t.listTitle}>
        <p className="-mt-2 mb-3.5 text-xs text-p-muted">{t.listDesc}</p>
        <BooksList initial={books} subjects={subjects} kinds={kinds} timeZone={timeZone} />
      </Panel>
      <AddBookPanel driveConfigured={driveConfigured} />
      <SearchPanel subjects={subjects} kinds={kinds} />
    </>
  );
}
