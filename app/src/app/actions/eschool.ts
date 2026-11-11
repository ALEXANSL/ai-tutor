"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireParentAccess, requireLessonAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { schoolPacketSchema } from "@/lib/eschool";
import { importSchoolPacket, updateSchoolEntry, disconnectSchool } from "@/server/eschool/service";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
function message(error: unknown) { unstable_rethrow(error); return error instanceof z.ZodError ? "Дані не відповідають формату помічника. Онови його й прочитай щоденник ще раз." : error instanceof Error && error.message.length < 400 && !/secret|api_key|supabase|postgres|fetch/i.test(error.message) ? error.message : "Не вдалося виконати дію. Онови сторінку й повтори."; }
export async function importSchoolAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try { const { child } = await voiceActor(familyId); const packet = schoolPacketSchema.parse(raw); const result = await importSchoolPacket(familyId, child.id, packet); revalidatePath("/parent/school"); revalidatePath("/school"); return { status: "ok" as const, ...result }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function setSchoolStatusAction(raw: unknown) {
  const { familyId } = await requireLessonAccess();
  try { const value = z.object({ id: z.string().uuid(), revision: z.number().int().min(0), status: z.enum(["todo", "working", "prepared", "done"]) }).strict().parse(raw); const { child } = await voiceActor(familyId); await updateSchoolEntry(familyId, child.id, value.id, value.revision, { status: value.status }); revalidatePath("/school"); revalidatePath("/parent/school"); return { status: "ok" as const }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function schoolLessonOptionsAction(subjectId: string) {
  const { familyId } = await requireParentAccess();
  try { z.string().uuid().parse(subjectId); const detail = await getSubjectDetail(familyId, subjectId); if (!detail) throw new Error("Предмет не знайдено."); return { status: "ok" as const, lessons: detail.topics.map(topic => ({ id: topic.id, title: topic.title, href: importedLessonHref(topic) })) }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function mapSchoolEntryAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try { const value = z.object({ id: z.string().uuid(), revision: z.number().int().min(0), subjectId: z.string().uuid().nullable(), topicId: z.string().uuid().nullable() }).strict().parse(raw); const { child } = await voiceActor(familyId); await updateSchoolEntry(familyId, child.id, value.id, value.revision, value); revalidatePath("/parent/school"); revalidatePath("/school"); return { status: "ok" as const }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function disconnectSchoolAction() {
  const { familyId } = await requireParentAccess();
  try { const { child } = await voiceActor(familyId); await disconnectSchool(familyId, child.id); revalidatePath("/parent/school"); return { status: "ok" as const }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function launchSchoolHomeworkAction(rawId: string) {
  const { familyId } = await requireLessonAccess();
  try { const id = z.string().uuid().parse(rawId); const { child } = await voiceActor(familyId); const { schoolHomeworkLaunch } = await import("@/server/eschool/homework"); const href = await schoolHomeworkLaunch(familyId, child.id, id); if (!href) throw new Error("Попроси тата прив’язати до завдання готовий урок. Поки можна відкрити предмет або оригінальний щоденник."); return { status: "ok" as const, href }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
