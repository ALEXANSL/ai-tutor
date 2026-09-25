import { notFound } from "next/navigation";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { PageTitle, Panel } from "../ui";

const SECTIONS = {
  conversations: uk.parent.nav.conversations,
  directives: uk.parent.nav.directives,
  budget: uk.parent.nav.budget,
} as const;

/** Menu sections implemented in later slices (S4, S8, S11) — placeholders for now. */
export default async function PlaceholderSection({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  await requireParentAccess();
  const title = SECTIONS[section as keyof typeof SECTIONS];
  if (!title) notFound();
  return (
    <>
      <PageTitle>{uk.parent.placeholder.title(title)}</PageTitle>
      <Panel>
        <p className="text-p-muted">{uk.parent.placeholder.body}</p>
      </Panel>
    </>
  );
}
