import "server-only";
import type { StudioProject } from "@/lib/studio";
import { queueLessonDeck, studioDeckId, studioDeckKey } from "@/server/decks/lesson-deck";
import { getDeck, updateDeck } from "@/server/decks/store";

type Publication = NonNullable<StudioProject["publication"]>;

/** D-134: once the parent publishes a Studio project that asked for narrated
 * presentations, queue one per published lesson version.
 * Best effort: a queue failure must not undo the lesson publication. */
export async function queueStudioDecks(family: string, projectId: string, project: StudioProject, publication: Publication, onlyLessons?: string[]) {
  if (!project.request.narratedDeck) return [];
  const failures: string[] = [];
  for (const [index, lesson] of publication.lessons.entries()) {
    if (onlyLessons && !onlyLessons.includes(lesson.id)) continue;
    const topicId = project.request.mode === "revision" && project.request.topicId ? project.request.topicId : lesson.topicId;
    try {
      if (lesson.previousDeckId) {
        const previous = await getDeck(family, lesson.previousDeckId);
        if (previous?.published) await updateDeck(family, lesson.previousDeckId, previous, { published: false });
      }
      await queueLessonDeck(family, {
        key: studioDeckKey(family, projectId, index, lesson.deckVersion), subjectId: publication.subjectId, topicId,
        title: lesson.title, href: `/literature-v3/${lesson.id}`, wishes: "", sourceHash: lesson.deckVersion,
      });
    } catch (error) {
      failures.push(lesson.id);
      console.error("studio deck queue failed", projectId, index, error instanceof Error ? error.message : error);
    }
  }
  return failures;
}

export const studioDeckStateLabel = (deck: { state: string; published: boolean }) =>
  deck.published ? "Опубліковано" : deck.state === "ready" ? "Готово до перегляду" : deck.state === "error" ? "Потрібна увага" : "Готується";

/** One status per published lesson, including rows that could not be queued. */
export async function studioProjectDecks(family: string, projectId: string, project: StudioProject) {
  if (!project.request.narratedDeck || !project.publication) return [];
  return Promise.all(project.publication.lessons.map(async (lesson, index) => {
    const id = studioDeckId(family, projectId, index, lesson.deckVersion);
    const deck = await getDeck(family, id).catch(() => null);
    const queueFailed = project.deckQueueFailures?.includes(lesson.id) === true;
    const label = queueFailed ? "Не вдалося підтвердити запуск"
      : deck === null ? "Стан тимчасово недоступний"
      : deck ? studioDeckStateLabel(deck) : "Підготовку ще не запущено";
    return { lessonId: lesson.id, id: deck ? id : null, title: lesson.title, label, retry: queueFailed || deck === undefined };
  }));
}
