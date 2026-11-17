"use server";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { commonsPictures, downloadCommonsPicture, editableIllustrationProject, illustrationTargetSchema, saveIllustration, saveIllustrationChanges } from "@/server/studio/illustrations";
function failure(error: unknown) { unstable_rethrow(error); return { status: "error" as const, message: error instanceof Error && !/fetch|sharp|supabase|STUDIO-|JSON|Input buffer|Zod/i.test(error.message) && error.message.length < 300 ? error.message : "Не вдалося обробити ілюстрацію. Спробуй інше зображення або онови урок." }; }
export async function searchStudioPicturesAction(query: string) {
  await requireParentAccess();
  try { return { status: "ok" as const, pictures: await commonsPictures(z.string().trim().min(2).max(200).parse(query)) }; } catch (error) { return failure(error); }
}
export async function addCommonsStudioPictureAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const input = illustrationTargetSchema.extend({ pageId: z.number().int().positive(), caption: z.string().trim().max(500) }).strict().parse(raw);
    await editableIllustrationProject(familyId, input);
    const picture = (await commonsPictures("", input.pageId))[0]; if (!picture) throw new Error("Зображення більше недоступне.");
    await saveIllustration(familyId, input, await downloadCommonsPicture(picture.url), { title: picture.title, caption: input.caption, credit: picture.credit, license: picture.license, sourceUrl: picture.sourceUrl });
    revalidatePath("/parent/studio"); return { status: "ok" as const };
  } catch (error) { return failure(error); }
}
export async function uploadStudioPictureAction(form: FormData) {
  const { familyId } = await requireParentAccess();
  try {
    const target = illustrationTargetSchema.parse({ id: form.get("id"), revision: Number(form.get("revision")), lessonIndex: Number(form.get("lessonIndex")), blockIndex: Number(form.get("blockIndex")) });
    await editableIllustrationProject(familyId, target);
    const file = form.get("file"); if (!(file instanceof File) || file.size > 3 * 1024 * 1024) throw new Error("Обери PNG/JPEG/WebP файл до 3 МБ.");
    const title = z.string().trim().min(1).max(200).parse(form.get("title")); const caption = z.string().trim().max(500).parse(form.get("caption"));
    const sourceUrl = z.union([z.literal(""), z.string().url().max(1000).refine(value => /^https?:\/\//.test(value))]).parse(form.get("sourceUrl"));
    await saveIllustration(familyId, target, new Uint8Array(await file.arrayBuffer()), { title, caption, sourceUrl, credit: "Додано батьками", license: "Власний матеріал" });
    revalidatePath("/parent/studio"); return { status: "ok" as const };
  } catch (error) { return failure(error); }
}
export async function studioPicturesAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const target = illustrationTargetSchema.parse(raw); const project = await editableIllustrationProject(familyId, target);
    const pictures = await Promise.all((project.units[target.lessonIndex]!.illustrations ?? []).map(async picture => {
      if (!picture.storagePath.startsWith(`studio-images/${familyId}/${target.id}/`)) throw new Error("Некоректне джерело ілюстрації.");
      const result = await forFamily(familyId).client.storage.from("course_assets").createSignedUrl(picture.storagePath, 900);
      return { ...picture, storagePath: "", url: result.data?.signedUrl ?? "" };
    }));
    return { status: "ok" as const, pictures };
  } catch (error) { return failure(error); }
}
export async function removeStudioPictureAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const input = illustrationTargetSchema.extend({ pictureId: z.string().regex(/^[a-f0-9]{24}$/) }).strict().parse(raw);
    const project = await editableIllustrationProject(familyId, input); const units = [...project.units];
    units[input.lessonIndex] = { ...units[input.lessonIndex]!, illustrations: (units[input.lessonIndex]!.illustrations ?? []).filter(picture => !(picture.id === input.pictureId && picture.blockIndex === input.blockIndex)) };
    await saveIllustrationChanges(familyId, input.id, project, units); revalidatePath("/parent/studio"); return { status: "ok" as const };
  } catch (error) { return failure(error); }
}
