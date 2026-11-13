"use server";
import { schoolEntrySubjects } from "@/lib/eschool-subject-match";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireParentAccess, requireLessonAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { schoolPacketSchema } from "@/lib/eschool";
import { importSchoolPacket, updateSchoolEntry, disconnectSchool, schoolSubjects } from "@/server/eschool/service";
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

export async function resolveSchoolContextAction(raw: unknown) {
  const { familyId } = await requireLessonAccess();
  try {
    const value = z.object({ entryId: z.string().uuid(), subjectId: z.string().uuid() }).strict().parse(raw);
    const { child } = await voiceActor(familyId);
    const { readSchoolDoc, SCHOOL_ENTRY } = await import("@/server/eschool/store");
    const { studioPublicationsForSubject } = await import("@/server/studio/links");
    const entry = await readSchoolDoc<import("@/lib/eschool").SchoolEntry>(familyId, child.id, value.entryId, SCHOOL_ENTRY);
    const subject = await getSubjectDetail(familyId, value.subjectId);
    if (!entry || !subject?.childVisible || (entry.subjectId ? entry.subjectId !== value.subjectId : !schoolEntrySubjects(entry, await schoolSubjects(familyId, true)).some(item => item.id === value.subjectId))) throw new Error("Запис щоденника або предмет недоступний.");
    const publications = await studioPublicationsForSubject(familyId, value.subjectId);
    const derivatives = new Set(publications.filter(item => item.baseTopicId).flatMap(item => item.lessons.map(lesson => lesson.topicId)));
    const topics = subject.topics.filter(topic => importedLessonHref(topic) && !derivatives.has(topic.id));
    const { resolveSchoolContext } = await import("@/server/eschool/contextMatch");
    const result = await resolveSchoolContext(familyId, child.id, value.subjectId, entry, topics);
    revalidatePath(`/subject/${value.subjectId}`);
    return { status: "ok" as const, ...result };
  } catch (error) { return { status: "error" as const, message: message(error) }; }
}
