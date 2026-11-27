import "server-only";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { getSubjectDetail } from "@/server/subjects/queries";
import { studioPublicationsForSubject } from "@/server/studio/links";
import { forFamily } from "@/server/db/family-scope";
import { DECK_TYPE } from "./store";

export const deckStateLabel = (deck: { state: string; published: boolean }) =>
  deck.published ? "опублікована" : deck.state === "ready" ? "готова до перегляду" : deck.state === "error" ? "потрібна увага" : "готується";

/** Parent view: the newest presentation of each lesson of the subject, any state. */
export async function lessonDeckStates(family: string, subjectId: string) {
  const { data, error } = await forFamily(family).select("jobs", "id,topicId:payload->>topicId,state:payload->>state,published:payload->>published")
    .eq("type", DECK_TYPE).eq("payload->>subjectId", subjectId).order("created_at", { ascending: false })
    .returns<{ id: string; topicId: string | null; state: string; published: string | boolean }[]>();
  if (error) throw new Error("Не вдалося отримати список презентацій.");
  const states: Record<string, { id: string; label: string }> = {};
  for (const deck of data) if (deck.topicId && !states[deck.topicId]) states[deck.topicId] = { id: deck.id, label: deckStateLabel({ state: deck.state, published: String(deck.published) === "true" }) };
  return states;
}

export async function deckLessonOptions(family: string, subjectId: string) {
  const [subject, publications] = await Promise.all([
    getSubjectDetail(family, subjectId), studioPublicationsForSubject(family, subjectId),
  ]);
  const revisions = publications.filter(p => p.mode === "revision" && p.baseTopicId);
  const replaced = new Set(revisions.flatMap(p => p.lessons.map(l => l.topicId)));
  return (subject?.topics ?? []).filter(t => importedLessonHref(t) && !replaced.has(t.id)).map(t => {
    const revision = revisions.find(p => p.baseTopicId === t.id)?.lessons[0];
    return { id: t.id, title: t.title, href: revision ? `/literature-v3/${revision.id}` : importedLessonHref(t)! };
  });
}
