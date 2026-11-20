import "server-only";
import { requireLessonAccess, requireParentAccess } from "@/server/auth/guards";
import { getSubjectDetail } from "@/server/subjects/queries";
import { getDeck } from "./store";

export async function accessibleDeck(id: string, preview: boolean) {
  const { familyId } = preview ? await requireParentAccess() : await requireLessonAccess();
  const deck = await getDeck(familyId, id);
  if (!deck) return null;
  if (!preview && (!deck.published || deck.state !== "ready" || !(await getSubjectDetail(familyId, deck.subjectId))?.childVisible)) return null;
  return { familyId, deck };
}
