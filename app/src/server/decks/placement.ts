import "server-only";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { getSubjectDetail } from "@/server/subjects/queries";
import { studioPublicationsForSubject } from "@/server/studio/links";

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
