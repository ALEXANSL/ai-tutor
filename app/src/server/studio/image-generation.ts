import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import type { StudioIllustration } from "@/lib/studio";
import { forFamily } from "@/server/db/family-scope";
import { getBudgetState, recordCall } from "@/server/ai/store";
import { registerJobHandler, type JobRow, type JobOutcome } from "@/server/jobs/runner";
import { editableIllustrationProject, normaliseIllustration, saveIllustrationChanges, type IllustrationTarget } from "./illustrations";
import { generateLessonImage, IMAGE_MODELS, IMAGE_RESERVE_USD, ImageProviderError, imageProviders, lessonIllustrationPrompt, type ImageProvider } from "./image-provider";
export const STUDIO_IMAGE = "studio.image";
export interface StudioImageJob {
  projectId: string; lessonIndex: number; blockIndex: number; provider: ImageProvider; prompt: string; title: string; caption: string;
  phase: "queued" | "running" | "ready" | "error"; providerStarted?: boolean; startedAt?: string;
  error?: string; costUsd?: number; estimated?: boolean; result?: StudioIllustration;
}
interface ImageRow extends JobRow { payload: StudioImageJob & Record<string, unknown>; status: string; locked_until?: string | null; }
export async function readImageJob(familyId: string, id: string): Promise<ImageRow | null> {
  const row = await forFamily(familyId).select("jobs", "*").eq("id", id).eq("type", STUDIO_IMAGE).maybeSingle<ImageRow>();
  if (row.error) throw new Error("Не вдалося прочитати стан ілюстрації."); return row.data;
}
export async function startImageGeneration(familyId: string, target: IllustrationTarget, requestId: string, provider: ImageProvider, wishes: string, caption: string) {
  const project = await editableIllustrationProject(familyId, target);
  const existing = await readImageJob(familyId, requestId);
  if (existing) { if (existing.payload.projectId !== target.id || existing.payload.lessonIndex !== target.lessonIndex) throw new Error("Запит уже використано для іншого уроку."); return existing.id; }
  if ((project.units[target.lessonIndex]!.illustrations?.length ?? 0) >= 8) throw new Error("В уроці вже 8 ілюстрацій. Прибери зайву перед генерацією.");
  if (!imageProviders().find(item => item.provider === provider)?.available) throw new Error("Обраний сервіс не підключено. Обери доступний сервіс.");
  const budget = await getBudgetState(familyId); if (["budget", "hard_stop"].includes(budget)) throw new Error("Генерацію зупинено сімейним лімітом ШІ. Перевір бюджет.");
  const unit = project.units[target.lessonIndex]!, block = unit.content.blocks[target.blockIndex]!;
  const payload: StudioImageJob = { projectId: target.id, lessonIndex: target.lessonIndex, blockIndex: target.blockIndex, provider, title: block.title, caption: caption || block.title, phase: "queued", prompt: lessonIllustrationPrompt({ subject: project.subjectName ?? project.plan?.title ?? unit.content.title, title: unit.content.title, blockTitle: block.title, text: block.text, age: project.request.age }, wishes) };
  const inserted = await forFamily(familyId).insert("jobs", { id: requestId, type: STUDIO_IMAGE, status: "queued", payload, max_attempts: 1, dedupe_key: `studio-image:${requestId}` });
  if (inserted.error && inserted.error.code !== "23505") throw new Error("Не вдалося зберегти запит генерації.");
  if (inserted.error) { const duplicate = await readImageJob(familyId, requestId); if (!duplicate || duplicate.payload.projectId !== target.id || duplicate.payload.lessonIndex !== target.lessonIndex) throw new Error("Онови урок перед новою генерацією."); }
  return requestId;
}
async function checkpoint(familyId: string, id: string, payload: StudioImageJob) {
  const saved = await forFamily(familyId).update("jobs", { payload }).eq("id", id).eq("type", STUDIO_IMAGE);
  if (saved.error) throw new Error("Не вдалося зберегти стан генерації.");
}
export async function runImageJob(job: JobRow, deadline: number): Promise<JobOutcome> {
  const fresh = await readImageJob(job.family_id, job.id); if (!fresh || ["ready", "error"].includes(fresh.payload.phase)) return;
  if (deadline - Date.now() < 200000) return { requeue: true, delaySeconds: 10 };
  let payload: StudioImageJob = { ...fresh.payload }; let logged = false; let costUsd = 0; let estimated = false; const started = Date.now();
  const record = async (status: "ok" | "error", input = 0, output = 0) => {
    await recordCall(job.family_id, { role: "studio.illustration", provider: payload.provider, model: IMAGE_MODELS[payload.provider], status, input_tokens: input, output_tokens: output, cached_input_tokens: 0, cache_write_tokens: 0, cost_usd: costUsd, latency_ms: Date.now() - started, fallback_used: false, ref_table: "jobs", ref_id: payload.projectId, ...(status === "error" ? { error: estimated ? "image_result_uncertain; conservative estimate" : "image_generation_failed" } : estimated ? { error: "usage_missing; conservative estimate" } : {}) }); logged = true;
  };
  try {
    if (payload.providerStarted) throw new ImageProviderError("Попередній виклик перервано. Списання можливе; автоматично повторювати його не будемо.", true, IMAGE_RESERVE_USD);
    if (["budget", "hard_stop"].includes(await getBudgetState(job.family_id))) throw new ImageProviderError("Досягнуто сімейний ліміт ШІ. Генерацію не запускали.", false);
    payload = { ...payload, phase: "running", providerStarted: true, startedAt: new Date().toISOString() }; await checkpoint(job.family_id, job.id, payload);
    const generated = await generateLessonImage(payload.provider, payload.prompt); costUsd = generated.costUsd; estimated = generated.estimated;
    await record("ok", generated.inputTokens, generated.outputTokens);
    const bytes = await normaliseIllustration(generated.bytes); const digest = createHash("sha256").update(bytes).digest("hex");
    const storagePath = `studio-images/${job.family_id}/${payload.projectId}/${digest}.jpg`;
    const uploaded = await forFamily(job.family_id).client.storage.from("course_assets").upload(storagePath, bytes, { contentType: "image/jpeg", upsert: true });
    if (uploaded.error) throw new Error("Зображення отримано, але його не вдалося зберегти. Вартість виклику враховано.");
    const provenance = "Згенеровано ШІ; художня ілюстрація або реконструкція";
    payload = { ...payload, phase: "ready", costUsd, estimated, result: { id: digest.slice(0, 24), blockIndex: payload.blockIndex, title: payload.title, caption: `${payload.caption}. ${provenance}.`, credit: `${payload.provider === "gemini" ? "Gemini" : "OpenAI"} · ${IMAGE_MODELS[payload.provider]}`, license: "ШІ-ілюстрація", sourceUrl: "", storagePath, byteSize: bytes.length } };
    await checkpoint(job.family_id, job.id, payload);
  } catch (error) {
    if (!logged) { costUsd = error instanceof ImageProviderError ? error.costUsd : payload.providerStarted ? IMAGE_RESERVE_USD : 0; estimated = costUsd > 0; await record("error"); }
    payload = { ...payload, phase: "error", costUsd, estimated, error: error instanceof ImageProviderError ? error.message : logged ? "Генерація не завершилася збереженням. Вартість запиту враховано; автоматичного повтору немає." : "Не вдалося запустити генерацію. Онови стан." };
    await checkpoint(job.family_id, job.id, payload);
  }
}
export function kickImageGeneration(familyId: string, id: string) {
  after(async () => {
    const scope = forFamily(familyId); const found = await readImageJob(familyId, id); if (!found || ["ready", "error"].includes(found.payload.phase)) return;
    const expired = found.status === "running" && !!found.locked_until && Date.parse(found.locked_until) < Date.now();
    const interrupted = found.status === "failed" && found.payload.providerStarted;
    if (found.status !== "queued" && !expired && !interrupted) return;
    let query = scope.update("jobs", { status: "running", attempts: found.attempts + 1, locked_until: new Date(Date.now() + 300000).toISOString() }).eq("id", id).eq("type", STUDIO_IMAGE).eq("status", found.status);
    if (expired) query = query.lt("locked_until", new Date().toISOString());
    const claim = await query.select("*").maybeSingle<JobRow>();
    if (!claim.data || claim.error) return;
    try { await runImageJob(claim.data, Date.now() + 240000); await scope.update("jobs", { status: "done", locked_until: null }).eq("id", id).eq("status", "running"); }
    catch { await scope.update("jobs", { status: "failed", locked_until: null, last_error: "image generation interrupted; no automatic retry" }).eq("id", id); }
  });
}
export function registerStudioImageJobs() { registerJobHandler(STUDIO_IMAGE, { run: (job, ctx) => runImageJob(job, ctx.deadline), isRetryable: () => false }); }
export async function attachGeneratedImage(familyId: string, target: IllustrationTarget, generationId: string) {
  const project = await editableIllustrationProject(familyId, target); const row = await readImageJob(familyId, generationId);
  const picture = row?.payload.result;
  if (!row || row.payload.projectId !== target.id || row.payload.lessonIndex !== target.lessonIndex || row.payload.phase !== "ready" || !picture || !picture.storagePath.startsWith(`studio-images/${familyId}/${target.id}/`)) throw new Error("Згенерована ілюстрація недоступна для цього уроку.");
  const unit = project.units[target.lessonIndex]!, pictures = unit.illustrations ?? [];
  if (pictures.some(item => item.id === picture.id && item.blockIndex === target.blockIndex)) return;
  if (pictures.length >= 8) throw new Error("В уроці вже 8 ілюстрацій.");
  const units = [...project.units]; units[target.lessonIndex] = { ...unit, illustrations: [...pictures, { ...picture, blockIndex: target.blockIndex }] };
  await saveIllustrationChanges(familyId, target.id, project, units);
}
