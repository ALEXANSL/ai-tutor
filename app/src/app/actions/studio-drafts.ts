"use server";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireParentAccess } from "@/server/auth/guards";
import { draftValuesSchema, launchStudioFormDraft, listStudioFormDrafts, readStudioFormDraft,
  saveStudioFormDraft, StudioFormDraftConflictError } from "@/server/studio/drafts";
import { kickStudio } from "@/server/studio/wake";

const uuid = z.string().uuid();
const revision = z.number().int().safe().nonnegative();
const saveInput = z.object({ id: uuid, revision: revision.nullable(), values: draftValuesSchema }).strict();
const launchInput = z.object({ id: uuid, revision }).strict();
function failure(error: unknown, fallback: string) {
  unstable_rethrow(error);
  return { status: "error" as const, message: error instanceof StudioFormDraftConflictError ? error.message
    : error instanceof z.ZodError ? (error.issues.find(issue => issue.code === "custom")?.message ?? "Перевір заповнення полів. Заповнення не втрачено; незавершені поля можна зберегти без запуску.") : fallback };
}
export async function readStudioFormDraftAction(id: string) {
  const { familyId } = await requireParentAccess();
  return readStudioFormDraft(familyId, uuid.parse(id));
}
export async function listStudioFormDraftsAction() {
  const { familyId } = await requireParentAccess();
  return listStudioFormDrafts(familyId);
}
export async function saveStudioFormDraftAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const input = saveInput.parse(raw);
    const draft = await saveStudioFormDraft(familyId, input.id, input.revision, input.values);
    revalidatePath("/parent/studio");
    return { status: "ok" as const, id: draft.id, revision: draft.revision };
  } catch (error) { return failure(error, "Не вдалося зберегти заповнення. Залиш форму відкритою та спробуй ще раз."); }
}
export async function launchStudioFormDraftAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const input = launchInput.parse(raw);
    const id = await launchStudioFormDraft(familyId, input.id, input.revision);
    kickStudio(familyId, id);
    revalidatePath("/parent/studio");
    return { status: "ok" as const, id };
  } catch (error) { return failure(error, "Не вдалося запустити підготовку. Заповнення збережено; онови сторінку й спробуй ще раз."); }
}
