import { LibraryReturn } from "@/components/library/LibraryReturn";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { libraryBook } from "@/server/audiobooks/library";
import { listAudioCards } from "@/server/audiobooks/store";
import { AudioCards } from "@/components/library/AudioCards";
import { LibrarySearch } from "@/components/library/LibrarySearch";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { familyId } = await requireLessonAccess(); const { id } = await params; if (!z.string().uuid().safeParse(id).success) notFound();
  const [book, cards] = await Promise.all([libraryBook(familyId, id), listAudioCards(familyId, id, true)]); if (!book) notFound();
  return <main className="mx-auto max-w-4xl space-y-6 px-4 pb-32 pt-20"><LibraryReturn /><Link href="/library" className="inline-flex min-h-11 items-center font-bold text-primary">← Моя бібліотека</Link><header><h1 className="text-3xl font-extrabold">{book.title}</h1>{book.author && <p className="mt-2 text-muted">{book.author}</p>}</header><LibrarySearch books={[book]} cards={cards} /><section><h2 className="mb-3 text-xl font-extrabold">Аудіочитання</h2>{cards.length ? <AudioCards cards={cards} parent={false} /> : <p className="rounded-2xl border border-line p-5 text-muted">Для цієї книги ще немає готового аудіо. Попроси тата підготувати потрібний розділ.</p>}</section><section className="rounded-2xl border border-line bg-surface p-5"><h2 className="text-xl font-extrabold">Зміст</h2><ol className="mt-4 space-y-2">{book.chapters.map((c, i) => <li key={i} className="rounded-xl border border-line p-3"><b>{c.title}</b><span className="ml-2 text-sm text-muted">{book.format === "epub" ? "Частини" : "PDF-сторінки"} {c.from}–{c.to}</span>{book.format === "pdf" && <Link className="mt-2 flex min-h-10 items-center font-bold text-primary" href={`/book/${id}?page=${c.from}`}>Відкрити в книзі →</Link>}</li>)}</ol>{!book.chapters.length && <p className="mt-3 text-muted">Зміст ще не підготовлений.</p>}{book.format === "pdf" && <Link href={`/book/${id}`} className="mt-4 inline-flex min-h-11 items-center rounded-xl border border-line px-4 font-bold">Відкрити підручник / PDF</Link>}</section></main>;
}
