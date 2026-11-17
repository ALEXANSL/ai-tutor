import "server-only";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { StudioIllustration, StudioProject } from "@/lib/studio";
import { studioPublicationVisible } from "@/lib/studio";
import { forFamily } from "@/server/db/family-scope";
import { readStudioProject, saveStudioProject } from "./store";
const BUCKET = "course_assets";
export const illustrationTargetSchema = z.object({ id: z.string().uuid(), revision: z.number().int().nonnegative(), lessonIndex: z.number().int().nonnegative(), blockIndex: z.number().int().min(0).max(7) });
export type IllustrationTarget = z.infer<typeof illustrationTargetSchema>;
export interface CommonsPicture { pageId: number; title: string; url: string; sourceUrl: string; credit: string; license: string; }
const plain = (value: unknown, max = 300) => typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/&(?:quot|amp|lt|gt);/g, code => ({ "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" })[code]!).trim().slice(0, max) : "";
export function commonsImageUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) || url.port || url.username || url.password || !url.pathname.startsWith("/wikipedia/commons/")) throw new Error("Недозволене джерело зображення.");
  return url.href;
}
export async function commonsPictures(query: string, pageId?: number): Promise<CommonsPicture[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({ action: "query", format: "json", prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "1000", ...(pageId ? { pageids: String(pageId) } : { generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: "8" }) }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "AITutor/1.0 (educational illustration search)" }, cache: "no-store" });
  if (!response.ok) throw new Error("Пошук зображень тимчасово недоступний. Можна завантажити власне фото.");
  const data = await response.json();
  return Object.values(data.query?.pages ?? {}).flatMap((raw) => {
    const page = raw as { pageid: number; title: string; imageinfo?: { thumburl?: string; url: string; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }[] };
    const info = page.imageinfo?.[0]; if (!info) return [];
    const license = plain(info.extmetadata?.LicenseShortName?.value);
    if (!license || !info.descriptionurl?.startsWith("https://commons.wikimedia.org/wiki/")) return [];
    try { return [{ pageId: page.pageid, title: plain(page.title.replace(/^File:/, "")), url: commonsImageUrl(info.thumburl ?? info.url), sourceUrl: info.descriptionurl, credit: plain(info.extmetadata?.Artist?.value), license }]; } catch { return []; }
  });
}
export async function editableIllustrationProject(familyId: string, target: IllustrationTarget): Promise<StudioProject> {
  const project = await readStudioProject(familyId, target.id);
  if (!project || project.revision !== target.revision || !["ready", "needs_changes", "published", "withdrawn"].includes(project.state) || !project.units[target.lessonIndex]?.content.blocks[target.blockIndex]) throw new Error("Онови урок перед зміною ілюстрацій. Підготовка має завершитися.");
  return project;
}
export async function normaliseIllustration(bytes: Uint8Array): Promise<Buffer> {
  if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error("Зображення завелике.");
  const image = sharp(bytes, { limitInputPixels: 40000000, failOn: "error" });
  const meta = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) > 1) throw new Error("Обери звичайне PNG, JPEG або WebP зображення.");
  return image.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
}
export async function saveIllustration(familyId: string, target: IllustrationTarget, bytes: Uint8Array, metadata: Pick<StudioIllustration, "title" | "caption" | "credit" | "license" | "sourceUrl">) {
  const project = await editableIllustrationProject(familyId, target);
  const existing = project.units[target.lessonIndex]!.illustrations ?? [];
  if (existing.length >= 8) throw new Error("До уроку можна додати 8 ілюстрацій. Спочатку прибери зайву.");
  const image = await normaliseIllustration(bytes);
  const digest = createHash("sha256").update(image).digest("hex");
  const storagePath = `studio-images/${familyId}/${target.id}/${digest}.jpg`;
  const uploaded = await forFamily(familyId).client.storage.from(BUCKET).upload(storagePath, image, { contentType: "image/jpeg", upsert: true });
  if (uploaded.error) throw new Error("Не вдалося зберегти зображення. Урок не змінено.");
  const illustration: StudioIllustration = { ...metadata, id: digest.slice(0, 24), blockIndex: target.blockIndex, storagePath, byteSize: image.length };
  if (existing.some(item => item.id === illustration.id && item.blockIndex === target.blockIndex)) throw new Error("Це зображення вже додане до цього блоку.");
  const units = [...project.units]; units[target.lessonIndex] = { ...units[target.lessonIndex]!, illustrations: [...existing, illustration] };
  await saveIllustrationChanges(familyId, target.id, project, units);
}
export async function saveIllustrationChanges(familyId: string, id: string, project: StudioProject, units: StudioProject["units"]) {
  await saveStudioProject(familyId, id, project, { units, ...(project.state === "published" || project.state === "withdrawn" ? { state: "ready" as const } : {}), publicationRevision: !!project.publication, childAccess: studioPublicationVisible(project) ? "enabled" : "disabled" });
}
export async function downloadCommonsPicture(url: string): Promise<Uint8Array> {
  const response = await fetch(commonsImageUrl(url), { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok || !/^image\/(jpeg|png|webp)(;|$)/i.test(response.headers.get("content-type") ?? "") || Number(response.headers.get("content-length")) > 8 * 1024 * 1024) throw new Error("Не вдалося отримати зображення. Обери інше.");
  const reader = response.body?.getReader(); if (!reader) throw new Error("Зображення порожнє.");
  const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > 8 * 1024 * 1024) throw new Error("Зображення завелике."); chunks.push(part.value); } } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
