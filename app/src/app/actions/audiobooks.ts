"use server";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireParentAccess, requireLessonAccess } from "@/server/auth/guards";
import { audioRequestSchema, librarySettingsSchema, audioRunning } from "@/lib/audiobooks";
import { libraryBook, originalBookText } from "@/server/audiobooks/library";
import { readAudioPart, saveAudioPart, saveLibrarySettings } from "@/server/audiobooks/store";
import { startAudioPart, commandAudioPart } from "@/server/audiobooks/workflow";
import { kickAudioPart } from "@/server/audiobooks/wake";
import { readAudioPosition, saveAudioPosition } from "@/server/audiobooks/positions";
const uuid = z.string().uuid();
function safeError(error: unknown) { unstable_rethrow(error); return error instanceof z.ZodError ? "Перевір заповнення полів і діапазон." : error instanceof Error && /^[А-ЯІЇЄҐ]/u.test(error.message) && error.message.length < 400 ? error.message : "Не вдалося виконати дію. Онови сторінку й перевір збережений стан."; }
export async function createAudioPartAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try { const input = z.object({ id: uuid, request: audioRequestSchema }).strict().parse(raw); const id = await startAudioPart(familyId, input.id, input.request); kickAudioPart(familyId, id); return { status: "ok" as const, id }; }
  catch (error) { return { status: "error" as const, message: safeError(error) }; }
}
export async function pollAudioPartAction(rawId: string) {
  const { familyId } = await requireParentAccess(); const id = uuid.parse(rawId);
  let part = await readAudioPart(familyId, id); if (!part) return null;
  if (audioRunning(part)) {
    if (part.activeCall && part.leaseUntil < Date.now()) part = await saveAudioPart(familyId, id, part, { state: "failed", activeCall: false, leaseUntil: 0, error: "Фоновий виклик перервано. Резерв збережено; повтор запускається лише вручну." });
    else kickAudioPart(familyId, id);
  }
  return part;
}
export async function commandAudioPartAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const input = z.object({ id: uuid, revision: z.number().int().nonnegative(), command: z.enum(["approve", "pause", "resume", "publish", "hide", "delete", "keep_all"]), text: z.string().max(60000).optional(), budget: z.number().min(0.5).max(25).optional() }).strict().parse(raw);
    await commandAudioPart(familyId, input.id, input.revision, input.command, input.text, input.budget); kickAudioPart(familyId, input.id);
    revalidatePath("/parent/library", "layout"); revalidatePath("/library", "layout"); return { status: "ok" as const };
  } catch (error) { return { status: "error" as const, message: safeError(error) }; }
}
export async function saveLibrarySettingsAction(rawId: string, raw: unknown) {
  const { familyId } = await requireParentAccess();
  try { const id = uuid.parse(rawId); const settings = librarySettingsSchema.parse(raw); const book = await libraryBook(familyId, id); if (!book) throw new Error("Книгу не знайдено."); if (book.format === "epub" && settings.printedConfirmed) throw new Error("EPUB не має сталої нумерації друкованих сторінок."); if (book.pages && settings.chapters.some(c => c.to > book.pages!)) throw new Error("Розділ виходить за межі книги."); await saveLibrarySettings(familyId, id, { ...settings, chaptersOverride: true }); revalidatePath(`/parent/library/books/${id}`); revalidatePath("/library", "layout"); return { status: "ok" as const }; }
  catch (error) { return { status: "error" as const, message: safeError(error) }; }
}
export async function refreshEpubOutlineAction(rawId: string) {
  const { familyId } = await requireParentAccess();
  try { const id = uuid.parse(rawId); const book = await libraryBook(familyId, id); if (!book || book.format !== "epub") throw new Error("Ця дія доступна для EPUB."); const extraction = await originalBookText(familyId, id); const chapters = extraction.units.map(u => ({ title: u.locator || `Розділ ${u.page}`, from: u.page, to: u.page })); await saveLibrarySettings(familyId, id, librarySettingsSchema.parse({ ...book.settings, chaptersOverride: true, chapters })); revalidatePath(`/parent/library/books/${id}`); return { status: "ok" as const, chapters }; }
  catch (error) { return { status: "error" as const, message: safeError(error) }; }
}
const point = z.object({ segment: z.number().int().min(0).max(100), seconds: z.number().min(0).max(3600) });
const positionSchema = point.extend({ speed: z.number().min(0.5).max(2), bookmark: point.nullable() }).strict();
export async function audioPositionAction(rawId: string, raw?: unknown) {
  const { ctx, familyId } = await requireLessonAccess(); const id = uuid.parse(rawId);
  const part = await readAudioPart(familyId, id); if (!part || part.state !== "ready" || !part.published) throw new Error("Аудіокнигу не опубліковано.");
  if (raw !== undefined) { const value = positionSchema.parse(raw); if (value.segment >= part.segments.length || (value.bookmark && value.bookmark.segment >= part.segments.length)) throw new Error("Невідома частина аудіо."); await saveAudioPosition(familyId, ctx.appUserId, id, value); return value; }
  return readAudioPosition(familyId, ctx.appUserId, id);
}
/** Text-only existing SQL index: search never pays for embedding generation. */
export async function libraryTextSearchAction(raw: string) {
  const { familyId } = await requireLessonAccess(); const query = z.string().trim().min(2).max(200).parse(raw);
  const { forFamily } = await import("@/server/db/family-scope"); const { buildTsQuery } = await import("@/server/search/query");
  const tsquery = buildTsQuery(query);
  let search = forFamily(familyId).select("chunks", "material_id,page,locator,text,materials!inner(title,name,owner_family_id,removed_at)").eq("materials.owner_family_id", familyId).is("materials.removed_at", null);
  search = tsquery ? search.textSearch("tsv", tsquery, { config: "simple" }) : search.ilike("text", `%${query.replace(/[\\%_]/g, "\\$&")}%`);
  const { data, error } = await search.order("ordinal").limit(12).returns<{ material_id: string; page: number | null; locator: string | null; text: string; materials: { title: string | null; name: string } }[]>();
  if (error) throw new Error("Пошук тимчасово недоступний.");
  return (data ?? []).map(r => ({ materialId: r.material_id, title: r.materials.title || r.materials.name, page: r.page, locator: r.locator, snippet: r.text.slice(0, 500) }));
}
