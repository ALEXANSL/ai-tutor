import { LibraryReturn } from "@/components/library/LibraryReturn";
import { requireLessonAccess } from "@/server/auth/guards";
import { libraryCatalog } from "@/server/audiobooks/library";
import { listAudioCards } from "@/server/audiobooks/store";
import { LibraryCatalog } from "@/components/library/LibraryCatalog";
import { AudioCards } from "@/components/library/AudioCards";
import { LibrarySearch } from "@/components/library/LibrarySearch";
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; returnTo?: string }> }) {
  const { familyId } = await requireLessonAccess(); const filters = await searchParams; const query = String(filters.q ?? "").slice(0, 120);
  const [books, cards] = await Promise.all([libraryCatalog(familyId, query), listAudioCards(familyId, undefined, true)]);
  return <main className="mx-auto max-w-5xl space-y-7 px-4 pb-32 pt-20 md:px-6"><LibraryReturn requested={filters.returnTo} /><header><h1 className="text-3xl font-extrabold">📚 Моя бібліотека</h1><p className="mt-2 text-muted">Знайди книгу, розділ або готове аудіочитання.</p></header><LibrarySearch books={books} cards={cards} /><section><h2 className="mb-4 text-xl font-extrabold">🎧 Можна слухати</h2>{cards.length ? <AudioCards cards={cards} parent={false} /> : <p className="text-muted">Тато ще не опублікував аудіочитання.</p>}</section><section><h2 className="mb-4 text-xl font-extrabold">Книги</h2><LibraryCatalog books={books} parent={false} query={query} /></section></main>;
}
