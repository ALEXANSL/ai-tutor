"use server";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { STUDIO_PROJECT } from "@/server/studio/store";
import { illustrationTargetSchema } from "@/server/studio/illustrations";
import { imageProviderSchema, imageProviders, IMAGE_RESERVE_USD, IMAGE_MODELS } from "@/server/studio/image-provider";
import { attachGeneratedImage, kickImageGeneration, readImageJob, startImageGeneration, STUDIO_IMAGE } from "@/server/studio/image-generation";
function failure(error: unknown) { unstable_rethrow(error); return { status: "error" as const, message: error instanceof Error && error.message.length < 350 && !/supabase|JSON|fetch|secret|token|STUDIO-|Zod/i.test(error.message) ? error.message : "Не вдалося виконати дію. Онови стан генерації перед повтором." }; }
export async function studioImageProvidersAction() { await requireParentAccess(); return { providers: imageProviders(), reserveUsd: IMAGE_RESERVE_USD }; }
export async function generateStudioImageAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const input = illustrationTargetSchema.extend({ requestId: z.string().uuid(), provider: imageProviderSchema, wishes: z.string().trim().max(1000), caption: z.string().trim().max(500) }).strict().parse(raw);
    const id = await startImageGeneration(familyId, input, input.requestId, input.provider, input.wishes, input.caption);
    kickImageGeneration(familyId, id); return { status: "ok" as const, id };
  } catch (error) { return failure(error); }
}
export async function pollStudioImageAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try {
    const input = z.object({ projectId: z.string().uuid(), lessonIndex: z.number().int().nonnegative(), generationId: z.string().uuid().optional() }).strict().parse(raw);
    const owned = await forFamily(familyId).select("jobs", "id").eq("id", input.projectId).eq("type", STUDIO_PROJECT).maybeSingle<{ id: string }>();
    if (owned.error || !owned.data) throw new Error("Урок недоступний.");
    let id = input.generationId;
    if (!id) { const latest = await forFamily(familyId).select("jobs", "id").eq("type", STUDIO_IMAGE).eq("payload->>projectId", input.projectId).eq("payload->>lessonIndex", String(input.lessonIndex)).order("created_at", { ascending: false }).limit(1).maybeSingle<{ id: string }>(); if (latest.error) throw new Error("Не вдалося оновити стан ілюстрації."); id = latest.data?.id; }
    if (!id) return { status: "ok" as const, generation: null };
    const row = await readImageJob(familyId, id);
    if (!row || row.payload.projectId !== input.projectId || row.payload.lessonIndex !== input.lessonIndex) throw new Error("Ілюстрація недоступна.");
    const data = row.payload; let url = "";
    if (data.result) { if (!data.result.storagePath.startsWith(`studio-images/${familyId}/${input.projectId}/`)) throw new Error("Некоректне джерело ілюстрації."); const signed = await forFamily(familyId).client.storage.from("course_assets").createSignedUrl(data.result.storagePath, 900); url = signed.data?.signedUrl ?? ""; }
    if (["queued", "running"].includes(data.phase)) kickImageGeneration(familyId, id);
    return { status: "ok" as const, generation: { id, imageId: data.result?.id ?? "", phase: data.phase, provider: data.provider, model: IMAGE_MODELS[data.provider], blockIndex: data.blockIndex, title: data.title, caption: data.result?.caption ?? data.caption, costUsd: data.costUsd ?? null, estimated: data.estimated ?? false, reserveUsd: IMAGE_RESERVE_USD, error: data.error ?? "", url } };
  } catch (error) { return failure(error); }
}
export async function attachStudioGeneratedImageAction(raw: unknown) {
  const { familyId } = await requireParentAccess();
  try { const input = illustrationTargetSchema.extend({ generationId: z.string().uuid() }).strict().parse(raw); await attachGeneratedImage(familyId, input, input.generationId); revalidatePath("/parent/studio"); return { status: "ok" as const }; }
  catch (error) { return failure(error); }
}
