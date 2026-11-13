import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { libraryBook } from "@/server/audiobooks/library";
import { listAudioCards } from "@/server/audiobooks/store";
import { LibraryBookEditor } from "@/components/library/LibraryBookEditor";
import { AudioCards } from "@/components/library/AudioCards";
export const maxDuration = 300;
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { familyId } = await requireParentAccess(); const { id } = await params; if (!z.string().uuid().safeParse(id).success) notFound();
  const [book, cards] = await Promise.all([libraryBook(familyId, id), listAudioCards(familyId, id)]); if (!book) notFound();
  return <div className="mx-auto max-w-4xl space-y-6"><Link href="/parent/library" className="inline-flex min-h-11 items-center font-bold text-p-primary">← Бібліотека</Link><header><h1 className="text-2xl font-bold">{book.title}</h1><p className="mt-2 text-sm text-p-muted">{book.format.toUpperCase()} · {book.format === "epub" ? "Навігація за частинами EPUB" : "Навігація за сторінками PDF"}</p></header>{["pdf", "epub"].includes(book.format) ? <LibraryBookEditor book={book} /> : <p className="rounded-xl border border-p-line p-4">Цей матеріал імпортовано як готові тексти. Для точної аудіокниги додай оригінальний EPUB/PDF через «Мої книги». Для навчального аудіоуроку можна використати готові матеріали.</p>}<Link href="/parent/audio-lessons/new" className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 font-bold text-p-primary">Підготувати аудіоурок із готового уроку</Link><section><h2 className="mb-3 text-xl font-bold">Підготовлені аудіочастини</h2><AudioCards cards={cards} parent /></section></div>;
}
