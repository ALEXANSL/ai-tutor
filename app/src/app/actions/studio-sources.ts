"use server";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { confirmBookOcr, requestReindex } from "@/server/ingest/pipeline";
import { kickJobs } from "@/server/jobs/kick";
import { uk } from "@/i18n/uk";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function studioSourceStatusAction(id: string) {
  const { familyId } = await requireParentAccess();
  if (!uuid.test(id)) throw new Error("Матеріал недоступний.");
  const scope = forFamily(familyId);
  const result = await scope.select("materials", "id,name,title,status,status_detail,page_count,char_count,progress,ocr_pages_total,ocr_estimated_cost_usd,structure_outline_result")
    .eq("id", id).neq("status", "removed").maybeSingle<{ id: string; name: string; title: string | null; status: string; status_detail: string | null; page_count: number | null; char_count: number | null; progress: { step?: string; done?: number; total?: number }; ocr_pages_total: number | null; ocr_estimated_cost_usd: number | null; structure_outline_result: { kind?: string; warnings?: string[]; tasks?: { label: string; text: string }[] } | null }>();
  if (result.error || !result.data) throw new Error("Не вдалося прочитати стан матеріалу.");
  const material = result.data;
  const chunks = await scope.select("chunks", "text,page,locator").eq("material_id", id).order("ordinal").limit(4).returns<{ text: string; page: number; locator: string | null }[]>();
  if (chunks.error) throw new Error("Не вдалося прочитати розпізнаний текст.");
  if (["queued", "indexing"].includes(material.status)) kickJobs();
  const details = uk.parent.books.details as Record<string, string>;
  return { id, title: material.title || material.name, status: material.status, detail: material.status_detail ? details[material.status_detail] || "Обробка зупинилася. Можна повторити її без нового завантаження файла." : null,
    progress: material.progress, pageCount: material.page_count, charCount: material.char_count, ocrPages: material.ocr_pages_total, ocrCost: Number(material.ocr_estimated_cost_usd ?? 0),
    tasks: material.structure_outline_result?.kind === "source_image" ? (material.structure_outline_result.tasks ?? []).slice(0, 20) : [],
    warnings: /^source_(?:image|document)$/.test(material.structure_outline_result?.kind ?? "") ? material.structure_outline_result?.warnings ?? [] : [],
    hasText: !!chunks.data?.length && (["ready", "ready_partial"].includes(material.status) || ["embed", "structure"].includes(material.progress?.step ?? "")), preview: (chunks.data ?? []).map(chunk => `${chunk.locator || `Частина ${chunk.page}`}\n${chunk.text}`).join("\n\n").slice(0, 5000),
  };
}
export async function resumeStudioSourceAction(id: string, ocr = false) {
  const { familyId, ctx } = await requireParentAccess();
  if (!uuid.test(id)) throw new Error("Матеріал недоступний.");
  const current = await forFamily(familyId).select("materials", "status").eq("id", id).maybeSingle<{ status: string }>();
  if (current.error || !current.data) throw new Error("Матеріал недоступний.");
  if (ocr) {
    if (current.data.status !== "scan_awaiting_ocr") throw new Error("Онови стан розпізнавання.");
    await confirmBookOcr(familyId, id, ctx.appUserId);
  } else {
    if (!["error", "deferred", "scan_no_text"].includes(current.data.status)) throw new Error("Обробка вже виконується або завершена.");
    await requestReindex(familyId, id);
  }
  kickJobs();
}
