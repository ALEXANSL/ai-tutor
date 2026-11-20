import Link from "next/link";
import { notFound } from "next/navigation";
import { deckLessonOptions } from "@/server/decks/placement";
import { accessibleDeck } from "@/server/decks/access";
import { DeckPlayer } from "@/components/decks/DeckPlayer";
export default async function PublishedDeckPage({ params }: { params: Promise<{id: string}> }) {
  const { id } = await params;
  const result = await accessibleDeck(id, false);
  if (!result) notFound();
  const { deck } = result;
  const lesson = deck.topicId ? (await deckLessonOptions(result.familyId, deck.subjectId)).find(t => t.id === deck.topicId) : null;
  return <main className="mx-auto max-w-5xl space-y-4 p-4"><Link href={`/subject/${deck.subjectId}`}>← До уроків предмета</Link>{lesson && <Link className="ml-4 underline" href={lesson.href}>До уроку «{lesson.title}»</Link>}<h1 className="text-2xl font-bold">{deck.title}</h1><DeckPlayer id={id} scripts={deck.slides.map(s => s.narration)} /></main>;
}
