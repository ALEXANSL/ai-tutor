import Link from "next/link";
import { requireParentAccess } from "@/server/auth/guards";
import { libraryCatalog } from "@/server/audiobooks/library";
import { LibraryCatalog } from "@/components/library/LibraryCatalog";
import { listAudioCards } from "@/server/audiobooks/store";
import { AudioCards } from "@/components/library/AudioCards";
export const maxDuration = 300;
export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { familyId } = await requireParentAccess(); const query = String((await searchParams).q ?? "").slice(0, 120);
  const [books, cards] = await Promise.all([libraryCatalog(familyId, query), listAudioCards(familyId)]);
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Особиста бібліотека</h1><p className="mt-2 text-sm text-p-muted">Книги, розділи та аудіочитання для твоєї сім’ї.</p><Link href="/parent/studio?tab=book" className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 font-bold">Додати книгу з Google Drive або пристрою →</Link><Link href="/parent/audio-lessons/new" className="mt-3 ml-2 inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 font-bold text-white">Підготувати аудіоурок із готового уроку</Link></header><LibraryCatalog books={books} parent query={query} /><section className="rounded-2xl border border-p-line bg-p-surface p-5"><h2 className="text-lg font-bold">Що зберігається</h2><p className="mt-2 text-sm leading-relaxed text-p-muted">Оригінали книг — у твоєму Google Drive. Для пошуку чинний індекс зберігає витягнутий текст у базі. Аудіомодуль зберігає погоджений сценарій вибраної частини та приватні аудіофайли; додаткову копію EPUB/PDF не створює. Видалення аудіопідготовки не видаляє оригінал або пошуковий індекс.</p></section><section><h2 className="mb-4 text-xl font-bold">Аудіотека та підготовки</h2>{cards.length ? <AudioCards cards={cards} parent /> : <p className="text-p-muted">Відкрий книгу й вибери перший розділ для озвучення.</p>}</section></div>;
}
