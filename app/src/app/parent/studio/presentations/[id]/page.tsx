import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
import { getDeck } from "@/server/decks/store";
import { DeckProgress } from "@/components/decks/DeckProgress";
import { DeckPlayer } from "@/components/decks/DeckPlayer";
import { publishDeck, retryDeck } from "@/app/actions/narrated-decks";
import { parentButton } from "@/app/parent/ui";
export const maxDuration = 300;
export default async function ParentDeckPage({ params }: { params: Promise<{id: string}> }) {
  const { familyId } = await requireParentAccess();
  const { id } = await params;
  const deck = await getDeck(familyId, id);
  if (!deck) notFound();
  return <main className="mx-auto max-w-5xl space-y-5"><Link href="/parent/studio/presentations">← Мої презентації</Link><h1 className="text-2xl font-bold">{deck.title}</h1>
    {deck.state === "processing" && <DeckProgress done={deck.slides.filter(s => s.ready).length} total={deck.slides.length} />}
    {deck.state === "error" && <><p role="alert">Підготовка зупинилась. {deck.error}</p><form action={retryDeck.bind(null, id)}><button className={parentButton}>Продовжити зі збереженого слайда</button></form></>}
    {deck.state === "ready" && <><p>{deck.published ? "Доступно дитині на сторінці предмета." : "Готово до попереднього перегляду."}</p><form action={publishDeck.bind(null, id, !deck.published)}><button className={parentButton}>{deck.published ? "Приховати від дитини" : "Опублікувати дитині"}</button></form><DeckPlayer id={id} scripts={deck.slides.map(s => s.narration)} preview /></>}
  </main>;
}
