import "server-only";
import { requireLessonAccess, requireParentAccess } from "@/server/auth/guards";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { getDeck } from "./store";

export async function accessibleDeck(id: string, preview: boolean) {
  const { familyId } = preview ? await requireParentAccess() : await requireLessonAccess();
  const deck = await getDeck(familyId, id);
  if (!deck) return null;
  if (!preview) {
    if (!deck.published || deck.state !== "ready") return null;
    const subject = await getSubjectDetail(familyId, deck.subjectId);
    if (!subject?.childVisible) return null;
    if (deck.topicId && !subject.topics.some(t => t.id === deck.topicId && importedLessonHref(t))) return null;
  }
  return { familyId, deck };
}
