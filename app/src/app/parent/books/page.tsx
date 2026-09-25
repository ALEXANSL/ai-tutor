import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { PageTitle, Panel } from "../ui";

/** "Мої книги" — a separate menu item (US-2.7 KP-3); filled in slice S1. */
export default async function BooksPage() {
  await requireParentAccess();
  const t = uk.parent.books;
  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <Panel>
        <p className="mb-2">{t.empty}</p>
        <p className="text-sm text-p-muted">{t.comingNext}</p>
      </Panel>
    </>
  );
}
