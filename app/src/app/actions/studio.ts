"use server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireParentAccess, requireChild } from "@/server/auth/guards";
import { studioPlanSchema, studioRequestSchema, studioLessonSchema, studioActive, studioPublicationVisible, type StudioActivity } from "@/lib/studio";
import { readStudioProject, saveStudioProject, STUDIO_STEP } from "@/server/studio/store";
import { validateStudioLesson, scheduleStudio, pauseStudio, resumeStudio, startStudio } from "@/server/studio/workflow";
import { activateStudioPublication } from "@/server/studio/publish";
import { kickStudio } from "@/server/studio/wake";
import { forFamily } from "@/server/db/family-scope";
import { studioLinksForPath } from "@/server/studio/links";
const idSchema = z.string().uuid();
function message(error: unknown) { unstable_rethrow(error); return error instanceof z.ZodError ? "Перевір заповнення полів і діапазон сторінок." : error instanceof Error && !/secret|token|api_key|fetch|supabase|postgres|JSON|STUDIO-/i.test(error.message) && error.message.length < 400 ? error.message : "Не вдалося виконати дію. Чернетку збережено; онови сторінку перед повтором."; }
export async function createStudioAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try { const parsed = z.object({ requestId: idSchema, request: studioRequestSchema }).strict().parse(raw); const id = await startStudio(familyId, parsed.request, parsed.requestId); kickStudio(familyId, id); revalidatePath("/parent/studio"); return { status: "ok" as const, id }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function pollStudioAction(rawId: string) {
  const { familyId } = await requireParentAccess(); const id = idSchema.parse(rawId);
  let project = await readStudioProject(familyId, id);
  if (!project) return { status: "error" as const, message: "Чернетку не знайдено." };
  let activity: StudioActivity = { queue: "none", checkedAt: new Date().toISOString() };
  if (studioActive(project.state)) {
    const job = await forFamily(familyId).select("jobs", "status,locked_until,created_at,run_after").eq("type", STUDIO_STEP).eq("payload->>projectId", id).eq("payload->>token", project.token).order("created_at", { ascending: false }).limit(1).maybeSingle<{ status: string; locked_until: string | null; created_at: string; run_after?: string | null }>();
    activity = { queue: job.error ? "unavailable" : job.data?.status === "queued" ? "queued" : job.data?.status === "running" ? "running" : job.data?.status === "done" ? "finished" : job.data?.status === "failed" ? "interrupted" : "none", checkedAt: new Date().toISOString(), runAfter: job.data?.run_after };
    if (!job.error && (job.data?.status === "failed" || (job.data?.status === "running" && job.data.locked_until && Date.parse(job.data.locked_until) + 30000 < Date.now()) || (!job.data && Date.now() - Date.parse(project.createdAt) > 120000))) {
      project = await saveStudioProject(familyId, id, project, { state: "failed", error: "STUDIO-INTERRUPTED: фоновий етап перервано. Готові частини збережено; можна повторити. Резерв невизначеного виклику не списано повторно." });
    } else if (job.data?.status === "queued") kickStudio(familyId, id);
  }
  return { status: "ok" as const, project, activity };
}
const commandSchema = z.object({ id: idSchema, revision: z.number().int().nonnegative(), command: z.enum(["approve", "retry", "revise", "publish"]), plan: studioPlanSchema.optional(), feedback: z.string().max(3000).optional(), budgetUsd: z.number().min(0.5).max(25).optional(), lessonIndex: z.number().int().min(0).max(5).optional() }).strict();
export async function commandStudioAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try { const input = commandSchema.parse(raw); await resumeStudio(familyId, input.id, input.revision, input.command, input.plan, input.feedback, input.budgetUsd, input.lessonIndex); kickStudio(familyId, input.id); revalidatePath("/parent/studio"); return { status: "ok" as const }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function pauseStudioAction(rawId: string, revision: number) {
  const { familyId } = await requireParentAccess();
  try { await pauseStudio(familyId, idSchema.parse(rawId), z.number().int().nonnegative().parse(revision)); return { status: "ok" as const }; }
  catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function setStudioAccessAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const value = z.object({ id: idSchema, revision: z.number().int().min(0), enabled: z.boolean() }).strict().parse(raw);
    const project = await readStudioProject(familyId, value.id);
    if (!project?.publication || project.revision !== value.revision || studioActive(project.state)) throw new Error("Онови проєкт. Доступ можна змінити після завершення поточного етапу.");
    if (project.state === "failed" && project.phase === "publish") throw new Error("Спочатку заверши незавершене збереження публікації.");
    if (value.enabled) await activateStudioPublication(familyId, project.publication, !project.request.subjectId);
    else {
      const hidden = await forFamily(familyId).update("literature_v3_lessons", { status: "needs_review" }).eq("package_id", project.publication.packageId);
      if (hidden.error) throw new Error("Не вдалося вимкнути доступ. Повтори після оновлення.");
      if (!project.request.subjectId) {
        const subject = await forFamily(familyId).update("subjects", { active: false }).eq("id", project.publication.subjectId);
        if (subject.error) throw new Error("Уроки вимкнено, але статус курсу потрібно оновити повторно.");
      }
    }
    const finished = ["published", "withdrawn"].includes(project.state) && !project.publicationRevision;
    await saveStudioProject(familyId, value.id, project, { childAccess: value.enabled ? "enabled" : "disabled", ...(finished ? { state: value.enabled ? "published" : "withdrawn" } : {}) });
    revalidatePath("/parent/studio"); revalidatePath("/subject", "layout"); revalidatePath("/today"); return { status: "ok" as const };
  } catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function withdrawStudioAction(rawId: string, revision: number) { return setStudioAccessAction({ id: rawId, revision, enabled: false }); }
export async function saveStudioLessonAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const value = z.object({ id: idSchema, revision: z.number().int().min(0), lessonIndex: z.number().int().min(0).max(5), lesson: studioLessonSchema, budgetUsd: z.number().min(0.5).max(25) }).strict().parse(raw);
    const project = await readStudioProject(familyId, value.id);
    if (!project || project.revision !== value.revision || !["ready", "needs_changes", "published", "withdrawn"].includes(project.state) || !project.units[value.lessonIndex]) throw new Error("Онови матеріал перед редагуванням.");
    const lesson = validateStudioLesson(project, value.lesson); const units = [...project.units]; units[value.lessonIndex] = { ...units[value.lessonIndex]!, content: lesson, review: null };
    const token = randomUUID();
    const next = await saveStudioProject(familyId, value.id, project, { units, state: "generating", phase: "review", cursor: value.lessonIndex, token, activeCall: false, error: null, request: { ...project.request, budgetUsd: value.budgetUsd }, publicationRevision: !!project.publication, childAccess: studioPublicationVisible(project) ? "enabled" : "disabled", feedback: "Збережено ручні виправлення. Рецензуй поточний candidate, перевір факти й відповідність схем. Старі зауваження не є доказом помилки.", editorNotes: [...(project.editorNotes ?? []), { at: new Date().toISOString(), lessonIndex: value.lessonIndex, text: "Збережено ручні виправлення тексту й озвучення; запущено перевірку рецензента." }].slice(-30) });
    try { await scheduleStudio(familyId, value.id, token); kickStudio(familyId, value.id); }
    catch { await saveStudioProject(familyId, value.id, next, { state: "failed", error: "Правки збережено, але черга недоступна. Повтори етап рецензії." }); }
    revalidatePath("/parent/studio"); return { status: "ok" as const };
  } catch (error) { return { status: "error" as const, message: message(error) }; }
}
export async function studioLessonLinksAction(pathname: string) {
  const { ctx } = await requireChild();
  try { return await studioLinksForPath(ctx.familyId, pathname.slice(0, 200)); }
  catch { return { back: null, links: [] }; }
}
/** Small standalone lesson files; full textbooks use the existing library uploader. No paid model call. */
export async function extractStudioFileAction(form: FormData) {
  await requireParentAccess();
  try {
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > 3 * 1024 * 1024) throw new Error("Обери TXT, MD або текстовий PDF до 3 МБ. Велику книгу додай через «Мої книги»." );
    const extension = file.name.split(".").at(-1)?.toLowerCase(); let text: string;
    if (extension === "txt" || extension === "md") text = await file.text();
    else if (extension === "pdf") {
      const { getDocumentProxy, extractText } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
      try { if (pdf.numPages > 80) throw new Error("Для PDF понад 80 сторінок скористайся бібліотекою й вибором сторінок."); const result = await extractText(pdf, { mergePages: false }); if (result.text.reduce((sum, part) => sum + part.trim().length, 0) < 100) throw new Error("У PDF немає достатнього текстового шару. Спочатку потрібне розпізнавання книги."); text = result.text.map((part, i) => `Сторінка PDF ${i + 1}:\n${part}`).join("\n\n"); }
      finally { await pdf.cleanup(); }
    } else throw new Error("Підтримуються TXT, MD і PDF. EPUB можна вибрати з бібліотеки." );
    text = text.replace(/\u0000/g, "").trim();
    if (text.length < 100 || text.length > 40000) throw new Error("Потрібно від 100 до 40 000 символів читабельного тексту. Для скану потрібна обробка книги, для великого тексту — вибір сторінок." );
    return { status: "ok" as const, text };
  } catch (error) { return { status: "error" as const, message: message(error) }; }
}
