import Link from "next/link";
import { requireParentAccess } from "@/server/auth/guards";
import { isUploadsFolderConfigured } from "@/server/drive/service";
import { listSubjects } from "@/server/books/queries";
import { listDecks } from "@/server/decks/store";
import { DeckUpload } from "@/components/decks/DeckUpload";
import { PageTitle, Panel } from "@/app/parent/ui";
export const maxDuration = 300;

export default async function PresentationsPage() {
  const { familyId } = await requireParentAccess();
  const [subjects, enabled, decks] = await Promise.all([listSubjects(familyId), isUploadsFolderConfigured(familyId), listDecks(familyId)]);
  return <main className="mx-auto max-w-4xl space-y-5"><Link href="/parent/studio">← Майстерня ШІ</Link>
    <PageTitle>Презентації з озвученням</PageTitle>
    <Panel title="Додати PPTX"><p className="mb-4 text-sm">Порядок, текст та ілюстрації слайдів зберігаються у статичному перегляді. ШІ підготує пояснення українською й озвучить кожен слайд у межах бюджету застосунку. Перед публікацією ти зможеш прослухати результат.</p>
      {enabled ? <DeckUpload subjects={subjects} /> : <Link href="/parent/settings">Підключити Google Drive для завантаження</Link>}</Panel>
    <Panel title="Мої презентації">{decks.length ? <ul>{decks.map(d => <li key={d.id}><Link className="block rounded-lg p-3 underline" href={`/parent/studio/presentations/${d.id}`}>{d.title} · {d.published === "true" ? "Опубліковано" : d.state === "ready" ? "Готово до перегляду" : d.state === "error" ? "Потрібна увага" : "Готується"}</Link></li>)}</ul> : <p>Тут з’являться завантажені презентації.</p>}</Panel>
    <Link className="underline" href="/parent/studio/new">Створити новий урок за матеріалами презентації</Link>
  </main>;
}
