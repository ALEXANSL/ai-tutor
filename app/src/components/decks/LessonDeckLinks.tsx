import Link from "next/link";
import { listDecks } from "@/server/decks/store";

export async function LessonDeckLinks({ familyId, subjectId, topicId }: { familyId: string; subjectId: string; topicId?: string | null }) {
  if (!topicId) return null;
  const decks = await listDecks(familyId, subjectId, topicId).catch(() => []);
  if (!decks.length) return null;
  return <aside aria-label="Додаткові матеріали уроку" className="mx-auto flex max-w-5xl flex-wrap gap-2 px-4 py-2">
    {decks.map(d => <Link key={d.id} href={`/presentations/${d.id}`} className="inline-flex min-h-11 items-center rounded-xl border border-secondary bg-surface px-4 font-bold">Презентація: {d.title}</Link>)}
  </aside>;
}
