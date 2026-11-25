import "server-only";
import type { StudioProject } from "@/lib/studio";
import { queueLessonDeck, studioDeckId, studioDeckKey } from "@/server/decks/lesson-deck";
import { getDeck } from "@/server/decks/store";

type Publication = NonNullable<StudioProject["publication"]>;

/** D-134: once the parent publishes a Studio project that asked for narrated
 * presentations, queue one per published lesson. Keys are per project and
 * lesson position, so republishing never prepares (or pays for) them again.
 * Best effort: a queue failure must not undo the lesson publication. */
export async function queueStudioDecks(family: string, projectId: string, project: StudioProject, publication: Publication) {
  if (!project.request.narratedDeck) return [];
  const queued: string[] = [];
  for (const [index, lesson] of publication.lessons.entries()) {
    const topicId = project.request.mode === "revision" && project.request.topicId ? project.request.topicId : lesson.topicId;
    try {
      queued.push(await queueLessonDeck(family, {
        key: studioDeckKey(family, projectId, index), subjectId: publication.subjectId, topicId,
        title: lesson.title, href: `/literature-v3/${lesson.id}`, wishes: "",
      }));
    } catch (error) { console.error("studio deck queue failed", projectId, index, error instanceof Error ? error.message : error); }
  }
  return queued;
}

export const studioDeckStateLabel = (deck: { state: string; published: boolean }) =>
  deck.published ? "Опубліковано" : deck.state === "ready" ? "Готово до перегляду" : deck.state === "error" ? "Потрібна увага" : "Готується";

/** Presentations queued for this project, in lesson order (missing ones skipped). */
export async function studioProjectDecks(family: string, projectId: string, project: StudioProject) {
  if (!project.request.narratedDeck || !project.publication) return [];
  const decks = await Promise.all(project.publication.lessons.map(async (_, index) => {
    const id = studioDeckId(family, projectId, index);
    const deck = await getDeck(family, id).catch(() => undefined);
    return deck ? { id, title: deck.title, label: studioDeckStateLabel(deck) } : null;
  }));
  return decks.filter(item => item !== null);
}
