import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { sourceTypes } from "@/core/registries/learning";
import { callStructured, callVisionStructured, embedTexts } from "../ai/router";
import { getBudget, loadPrice, loadRoute } from "../ai/store";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError } from "../ai/types";
import { forFamily, type FamilyScope } from "../db/family-scope";
import { DriveError, downloadFile, listFolderFiles } from "../drive/google";
import { getDriveAccess } from "../drive/service";
import { enqueueJob, registerJobHandler, type JobRow } from "../jobs/runner";
import { EpubError } from "./extract-epub";
import { sourceExtractors, type SourceFormat } from "./extractors";
import {
  batchPages,
  estimateOcrCostUsd,
  mergeOcrIntoUnits,
  needsOcrConfirmation,
  OCR_BATCH_PAGES,
  ocrResultSchema,
  pagesNeedingOcr,
  type OcrResult,
} from "./ocr";
import {
  buildOutline,
  buildStructureSchema,
  fillTemplate,
  mergeByTitle,
  normalizeSections,
  splitPrompt,
  type PageText,
} from "./structure";
import { planSync, type KnownMaterial } from "./sync-plan";
import { chunkUnits, type ExtractedUnit } from "./text";

/**
 * Universal ingest pipeline (docs/02 9.1, ADR-008, ADR-017):
 * drive.sync → ingest.extract → ingest.embed → ingest.structure.
 * Every step is a separate job (≤ 300 s), resumable after a crash.
 */
export const JOB = {
  sync: "drive.sync",
  extract: "ingest.extract",
  ocr: "ingest.ocr",
  embed: "ingest.embed",
  structure: "ingest.structure",
} as const;

/** Error codes shown to the parent (texts in i18n: uk.parent.books.details). */
export type MaterialErrorCode =
  | "drive_not_configured"
  | "drive_forbidden"
  | "drive_file_missing"
  | "too_large"
  | "extract_failed"
  | "empty"
  | "ai_not_configured"
  | "ai_failed"
  | "failed";

export class IngestError extends Error {
  constructor(
    readonly code: MaterialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

export function errorCodeOf(e: unknown): MaterialErrorCode {
  if (e instanceof IngestError) return e.code;
  if (e instanceof AiNotConfiguredError) return "ai_not_configured";
  if (e instanceof ProviderError) return "ai_failed";
  if (e instanceof EpubError) return "extract_failed";
  if (e instanceof DriveError) {
    if (e.code === "not_configured") return "drive_not_configured";
    if (e.code === "forbidden") return "drive_forbidden";
    if (e.code === "not_found") return "drive_file_missing";
    if (e.code === "too_large") return "too_large";
  }
  return "failed";
}

export function isRetryableIngestError(e: unknown): boolean {
  if (e instanceof ProviderError) return e.retryable;
  if (e instanceof DriveError) return e.code === "network" || e.code === "http";
  if (e instanceof IngestError || e instanceof AiNotConfiguredError || e instanceof EpubError) return false;
  return true;
}

const budgetBlocks = (state: string) => state === "budget" || state === "hard_stop";

async function patchMaterial(scope: FamilyScope, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await scope.update("materials", patch).eq("id", id);
  if (error) throw new Error(`materials update failed: ${error.message}`);
}

const dedupe = (type: string, materialId: string) => `${type}:${materialId}`;

async function enqueueStep(familyId: string, type: string, materialId: string, extra: Record<string, unknown> = {}) {
  await enqueueJob(familyId, type, { materialId, ...extra }, { dedupeKey: dedupe(type, materialId) });
}

// ---------------------------------------------------------------------------
// drive.sync
// ---------------------------------------------------------------------------
export interface SyncSummary {
  total: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  deferred: number;
}

export async function syncDriveFolder(familyId: string): Promise<SyncSummary> {
  const scope = forFamily(familyId);
  const { folderId, token } = await getDriveAccess(familyId);
  const { files, skipped } = await listFolderFiles(folderId, await token());
  const { data: known, error } = await scope
    .select("materials", "id, drive_file_id, name, drive_md5, drive_modified_time, status, status_detail")
    .returns<KnownMaterial[]>();
  if (error) throw new Error(`materials select failed: ${error.message}`);
  const budget = await getBudget(familyId);
  const plan = planSync(known ?? [], files, { budgetBlocked: budgetBlocks(budget.state) });

  const driveMeta = (f: (typeof files)[number]) => ({
    name: f.name,
    mime: f.mimeType,
    format: f.format,
    drive_md5: f.md5Checksum ?? null,
    drive_modified_time: f.modifiedTime ?? null,
    size_bytes: f.size ? Number(f.size) : null,
  });

  const toQueue: string[] = [];
  if (plan.insert.length) {
    const { data, error: insErr } = await scope.client
      .from("materials")
      .insert(
        plan.insert.map(({ file, status }) => ({
          owner_family_id: familyId,
          drive_file_id: file.id,
          ...driveMeta(file),
          status,
          status_detail: status === "deferred" ? "budget_deferred" : null,
          progress: {},
        })),
      )
      .select("id, status")
      .returns<{ id: string; status: string }[]>();
    if (insErr) throw new Error(`materials insert failed: ${insErr.message}`);
    toQueue.push(...(data ?? []).filter((r) => r.status === "queued").map((r) => r.id));
  }
  for (const r of plan.requeue) {
    await patchMaterial(scope, r.id, {
      ...driveMeta(r.file),
      status: r.status,
      status_detail: r.status === "deferred" ? "budget_deferred" : null,
      removed_at: null,
      progress: {},
    });
    if (r.status === "queued") toQueue.push(r.id);
  }
  for (const r of plan.rename) await patchMaterial(scope, r.id, { name: r.name });
  if (plan.remove.length) {
    // US-2.6 KP-6: the book disappears from sources and search; the row stays so that
    // lessons referring to it can show "джерело видалено".
    const { error: remErr } = await scope
      .update("materials", { status: "removed", removed_at: new Date().toISOString(), status_detail: null })
      .in("id", plan.remove);
    if (remErr) throw new Error(`materials remove failed: ${remErr.message}`);
    await scope.delete("chunks").in("material_id", plan.remove);
  }
  for (const id of toQueue) await enqueueStep(familyId, JOB.extract, id);

  return {
    total: files.length,
    added: plan.insert.length,
    updated: plan.requeue.length,
    removed: plan.remove.length,
    skipped,
    deferred: [...plan.insert, ...plan.requeue].filter((x) => x.status === "deferred").length,
  };
}

/** "Переіндексувати" (parent): the whole pipeline again; unchanged files skip straight to the structure. */
export async function requestReindex(familyId: string, materialId: string): Promise<"queued" | "deferred"> {
  const scope = forFamily(familyId);
  const budget = await getBudget(familyId);
  const status = budgetBlocks(budget.state) ? "deferred" : "queued";
  await patchMaterial(scope, materialId, {
    status,
    status_detail: status === "deferred" ? "budget_deferred" : null,
    progress: {},
  });
  if (status === "queued") await enqueueStep(familyId, JOB.extract, materialId);
  return status;
}

// ---------------------------------------------------------------------------
// ingest.extract
// ---------------------------------------------------------------------------
interface MaterialRow {
  id: string;
  name: string;
  title: string | null;
  format: SourceFormat;
  drive_file_id: string;
  status: string;
  content_hash: string | null;
  kind: string;
  kind_manual: boolean;
  subject_id: string | null;
  subject_manual: boolean;
  topics_manual: boolean;
  page_count: number | null;
  grade: number | null;
  curriculum_version: string | null;
  ocr_confirmed_at: string | null;
}

async function loadMaterial(scope: FamilyScope, id: string): Promise<MaterialRow | null> {
  const { data } = await scope
    .select(
      "materials",
      "id, name, title, format, drive_file_id, status, content_hash, kind, kind_manual, subject_id, subject_manual, topics_manual, page_count, grade, curriculum_version, ocr_confirmed_at",
    )
    .eq("id", id)
    .maybeSingle<MaterialRow>();
  return data ?? null;
}

async function deferIfBudget(scope: FamilyScope, familyId: string, materialId: string): Promise<boolean> {
  const budget = await getBudget(familyId);
  if (!budgetBlocks(budget.state)) return false;
  await patchMaterial(scope, materialId, { status: "deferred", status_detail: "budget_deferred" });
  return true;
}

/** Chunks the merged units, saves them and hands off to `ingest.embed` — the shared tail of a text extraction and an OCR run (D-54). */
async function finishExtraction(
  scope: FamilyScope,
  familyId: string,
  materialId: string,
  base: Record<string, unknown>,
  units: ExtractedUnit[],
): Promise<void> {
  await scope.delete("chunks").eq("material_id", materialId);
  const chunks = chunkUnits(units);
  if (chunks.length === 0) throw new IngestError("empty", "no text found");
  for (let i = 0; i < chunks.length; i += 200) {
    const { error } = await scope.insert(
      "chunks",
      chunks.slice(i, i + 200).map((c) => ({ material_id: materialId, ordinal: c.ordinal, page: c.page, locator: c.locator, text: c.text })),
    );
    if (error) throw new Error(`chunks insert failed: ${error.message}`);
  }
  await patchMaterial(scope, materialId, { ...base, progress: { step: "embed", done: 0, total: chunks.length } });
  await enqueueStep(familyId, JOB.embed, materialId);
}

/** Threshold above which a scan waits for the parent's "Розпізнати" (D-54, default 20 pages). */
async function ocrConfirmThreshold(scope: FamilyScope): Promise<number> {
  const { data } = await scope.select("parent_settings", "ocr_confirm_above_pages").maybeSingle<{ ocr_confirm_above_pages: number }>();
  return data?.ocr_confirm_above_pages ?? 20;
}

/** Estimated USD cost of OCR-ing `pageCount` pages with the family's current `ocr_page` route (D-54, shown before confirmation). */
export async function estimateOcrCost(familyId: string, pageCount: number): Promise<number> {
  const route = await loadRoute(familyId, "ocr_page");
  if (!route) return 0;
  const price = await loadPrice(route.primary_provider, route.primary_model);
  return estimateOcrCostUsd(pageCount, price);
}

/** The parent's "Розпізнати" for a scan over the threshold (D-54): confirms the spend and resumes ingest.extract. */
export async function confirmBookOcr(familyId: string, materialId: string, confirmedBy: string | null): Promise<void> {
  const scope = forFamily(familyId);
  const { error } = await scope
    .update("materials", { ocr_confirmed_at: new Date().toISOString(), ocr_confirmed_by: confirmedBy, status: "queued", progress: {} })
    .eq("id", materialId)
    .eq("status", "scan_awaiting_ocr");
  if (error) throw new Error(`confirmBookOcr failed: ${error.message}`);
  await enqueueStep(familyId, JOB.extract, materialId);
}

/**
 * QA regression: re-indexing the same unchanged file must not run OCR (or
 * any extraction) a second time — `runExtract` skips straight to
 * `ingest.embed` when the downloaded bytes hash to the same
 * `materials.content_hash` as last time AND chunks from that indexing are
 * still there (a wiped/never-finished index still needs a real re-extract,
 * even with a matching hash).
 */
export function skipReextraction(hash: string, previousContentHash: string | null, existingChunkCount: number): boolean {
  return hash === previousContentHash && existingChunkCount > 0;
}

async function runExtract(job: JobRow): Promise<void> {
  const familyId = job.family_id;
  const materialId = String(job.payload.materialId);
  const scope = forFamily(familyId);
  const m = await loadMaterial(scope, materialId);
  if (!m || m.status === "removed") return;
  if (await deferIfBudget(scope, familyId, materialId)) return;

  await patchMaterial(scope, materialId, { status: "indexing", status_detail: null, progress: { step: "download" } });
  const { token } = await getDriveAccess(familyId);
  const bytes = await downloadFile(m.drive_file_id, await token());
  const hash = createHash("sha256").update(bytes).digest("hex");

  if (hash === m.content_hash) {
    const { count } = await scope.count("chunks").eq("material_id", materialId);
    if (skipReextraction(hash, m.content_hash, count ?? 0)) {
      await patchMaterial(scope, materialId, { progress: { step: "embed" } });
      await enqueueStep(familyId, JOB.embed, materialId);
      return;
    }
  }

  await patchMaterial(scope, materialId, { progress: { step: "extract" } });
  let extraction;
  try {
    extraction = await sourceExtractors[m.format](bytes);
  } catch (e) {
    if (e instanceof EpubError) throw e;
    throw new IngestError("extract_failed", `extraction failed: ${(e as Error).message}`);
  }
  const base = {
    content_hash: hash,
    size_bytes: bytes.byteLength,
    page_count: extraction.pageCount,
    char_count: extraction.charCount,
    ...(m.title ? {} : { title: extraction.title }),
  };

  // D-54: pages (or the whole book) without a usable text layer go through OCR
  // instead of the old blanket "скан без тексту" refusal (US-2.2 KP-3).
  const scanPages = m.format === "pdf" ? pagesNeedingOcr(extraction.units) : [];
  if (scanPages.length === 0) {
    await finishExtraction(scope, familyId, materialId, base, extraction.units);
    return;
  }

  if (!m.ocr_confirmed_at && needsOcrConfirmation(scanPages.length, await ocrConfirmThreshold(scope))) {
    const estimate = await estimateOcrCost(familyId, scanPages.length);
    await patchMaterial(scope, materialId, {
      ...base,
      status: "scan_awaiting_ocr",
      status_detail: null,
      ocr_pages_total: scanPages.length,
      ocr_pages_done: 0,
      ocr_estimated_cost_usd: estimate,
      progress: {},
    });
    return;
  }

  const { error: pagesErr } = await scope.upsert(
    "material_ocr_pages",
    scanPages.map((page) => ({ material_id: materialId, page, status: "pending", text: "" })),
    "material_id,page",
  );
  if (pagesErr) throw new Error(`material_ocr_pages upsert failed: ${pagesErr.message}`);
  await patchMaterial(scope, materialId, {
    ...base,
    status: "indexing",
    status_detail: null,
    ocr_pages_total: scanPages.length,
    progress: { step: "ocr", done: 0, total: scanPages.length },
  });
  await enqueueStep(familyId, JOB.ocr, materialId);
}

// ---------------------------------------------------------------------------
// ingest.ocr (D-54)
// ---------------------------------------------------------------------------
let ocrPromptCache: { system: string; user: string } | null = null;
function ocrPrompt(): { system: string; user: string } {
  ocrPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "ocr_page.md"), "utf8"));
  return ocrPromptCache;
}

/** Finishes a book after all its scanned pages are recognised (or given up on): merges OCR text with the text layer and hands off to chunking (D-54). */
async function finalizeAfterOcr(scope: FamilyScope, familyId: string, materialId: string, m: MaterialRow, bytes: Uint8Array): Promise<void> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const extraction = await sourceExtractors.pdf(bytes);
  const { data: ocrRows } = await scope
    .select("material_ocr_pages", "page, status, text")
    .eq("material_id", materialId)
    .returns<{ page: number; status: string; text: string }[]>();
  const ocrTextByPage = new Map((ocrRows ?? []).filter((r) => r.status === "done").map((r) => [r.page, r.text]));
  const merged = mergeOcrIntoUnits(extraction.units, ocrTextByPage);
  const base = {
    content_hash: hash,
    size_bytes: bytes.byteLength,
    page_count: extraction.pageCount,
    char_count: merged.reduce((n, u) => n + u.text.length, 0),
    ...(m.title ? {} : { title: extraction.title }),
  };
  try {
    await finishExtraction(scope, familyId, materialId, base, merged);
  } catch (e) {
    if (e instanceof IngestError && e.code === "empty") {
      // D-54: a scan that could not be recognised at all — a clear status, not a silent failure.
      await patchMaterial(scope, materialId, { ...base, status: "scan_no_text", status_detail: "scan_unreadable", progress: {} });
      return;
    }
    throw e;
  }
}

async function runOcr(job: JobRow, ctx: { deadline: number }): Promise<void | { requeue: true }> {
  const familyId = job.family_id;
  const materialId = String(job.payload.materialId);
  const scope = forFamily(familyId);
  const m = await loadMaterial(scope, materialId);
  if (!m || m.status === "removed") return;
  if (await deferIfBudget(scope, familyId, materialId)) return;

  const { token } = await getDriveAccess(familyId);
  const bytes = await downloadFile(m.drive_file_id, await token());
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const { system, user } = ocrPrompt();

  const { data: pendingRows } = await scope
    .select("material_ocr_pages", "page")
    .eq("material_id", materialId)
    .eq("status", "pending")
    .order("page")
    .returns<{ page: number }[]>();
  const batches = batchPages((pendingRows ?? []).map((r) => r.page), OCR_BATCH_PAGES);

  for (const batch of batches) {
    if (Date.now() > ctx.deadline - 30_000) return { requeue: true };

    const sub = await PDFDocument.create();
    const copied = await sub.copyPages(pdf, batch.map((p) => p - 1));
    copied.forEach((p) => sub.addPage(p));
    const data = Buffer.from(await sub.save()).toString("base64");
    const prompt = fillTemplate(user, { page_count: String(batch.length), book_name: m.title ?? m.name });

    let answer: OcrResult;
    try {
      const res = await callVisionStructured(
        "ocr_page",
        { system, prompt, schema: ocrResultSchema(batch.length), documents: [{ mediaType: "application/pdf", data }] },
        { familyId, ref: { table: "materials", id: materialId } },
      );
      answer = res.result;
    } catch (e) {
      if (e instanceof BudgetBlockedError) {
        await patchMaterial(scope, materialId, { status: "deferred", status_detail: "budget_deferred" });
        return;
      }
      throw e;
    }

    const byIndex = new Map(answer.pages.map((p) => [p.index, p]));
    const rows = batch.map((page, i) => {
      const r = byIndex.get(i + 1);
      const text = r?.text.trim() ?? "";
      return { material_id: materialId, page, status: !r || r.unreadable || !text ? "unreadable" : "done", text };
    });
    const { error } = await scope.upsert("material_ocr_pages", rows, "material_id,page");
    if (error) throw new Error(`material_ocr_pages upsert failed: ${error.message}`);

    const [{ count: left }, { count: total }] = await Promise.all([
      scope.count("material_ocr_pages").eq("material_id", materialId).eq("status", "pending"),
      scope.count("material_ocr_pages").eq("material_id", materialId),
    ]);
    await patchMaterial(scope, materialId, { progress: { step: "ocr", done: (total ?? 0) - (left ?? 0), total } });
  }

  const { count: leftAfter } = await scope.count("material_ocr_pages").eq("material_id", materialId).eq("status", "pending");
  if ((leftAfter ?? 0) > 0) return { requeue: true };
  await finalizeAfterOcr(scope, familyId, materialId, m, bytes);
}

// ---------------------------------------------------------------------------
// ingest.embed
// ---------------------------------------------------------------------------
async function runEmbed(job: JobRow, ctx: { deadline: number }): Promise<void | { requeue: true }> {
  const familyId = job.family_id;
  const materialId = String(job.payload.materialId);
  const scope = forFamily(familyId);
  const m = await loadMaterial(scope, materialId);
  if (!m || m.status === "removed") return;

  const { count: total } = await scope.count("chunks").eq("material_id", materialId);
  while (Date.now() < ctx.deadline - 30_000) {
    const { data: batch, error } = await scope
      .select("chunks", "id, text")
      .eq("material_id", materialId)
      .is("embedding", null)
      .order("ordinal")
      .limit(64)
      .returns<{ id: string; text: string }[]>();
    if (error) throw new Error(`chunks select failed: ${error.message}`);
    if (!batch?.length) {
      await patchMaterial(scope, materialId, { progress: { step: "structure", done: total, total } });
      await enqueueStep(familyId, JOB.structure, materialId);
      return;
    }
    let res;
    try {
      res = await embedTexts(
        batch.map((c) => c.text),
        { familyId, ref: { table: "materials", id: materialId } },
      );
    } catch (e) {
      if (e instanceof BudgetBlockedError) {
        await patchMaterial(scope, materialId, { status: "deferred", status_detail: "budget_deferred" });
        return;
      }
      throw e;
    }
    const items = batch.map((c, i) => ({ id: c.id, embedding: res.result[i] }));
    const { error: setErr } = await scope.client.rpc("set_chunk_embeddings", {
      p_family_id: familyId,
      p_model: res.model.model,
      p_items: items,
    });
    if (setErr) throw new Error(`set_chunk_embeddings failed: ${setErr.message}`);
    const { count: left } = await scope.count("chunks").eq("material_id", materialId).is("embedding", null);
    await patchMaterial(scope, materialId, { progress: { step: "embed", done: (total ?? 0) - (left ?? 0), total } });
  }
  return { requeue: true };
}

// ---------------------------------------------------------------------------
// ingest.structure
// ---------------------------------------------------------------------------
let promptCache: { system: string; user: string } | null = null;
function structurePrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "indexing_structure.md"), "utf8"));
  return promptCache;
}

async function runStructure(job: JobRow): Promise<void> {
  const familyId = job.family_id;
  const materialId = String(job.payload.materialId);
  const scope = forFamily(familyId);
  const m = await loadMaterial(scope, materialId);
  if (!m || m.status === "removed") return;
  if (await deferIfBudget(scope, familyId, materialId)) return;

  const [{ data: chunkRows }, { data: subjects }, { data: topics }, { data: year }] = await Promise.all([
    scope
      .select("chunks", "page, locator, text, ordinal")
      .eq("material_id", materialId)
      .order("ordinal")
      .limit(20000)
      .returns<{ page: number; locator: string | null; text: string }[]>(),
    scope.select("subjects", "id, code, name_uk, is_stub").returns<{ id: string; code: string; name_uk: string; is_stub: boolean }[]>(),
    scope
      .select("topics", "id, title, subject_id, material_id")
      .or(`material_id.is.null,material_id.neq.${materialId}`)
      .order("sort_order")
      .limit(300)
      .returns<{ id: string; title: string; subject_id: string; material_id: string | null }[]>(),
    scope.select("academic_years", "grade").eq("status", "active").maybeSingle<{ grade: number }>(),
  ]);

  const pages = new Map<number, PageText>();
  for (const c of chunkRows ?? []) {
    const p = pages.get(c.page) ?? { page: c.page, locator: c.locator, text: "" };
    p.text = p.text ? `${p.text}\n${c.text}` : c.text;
    pages.set(c.page, p);
  }
  const kinds = sourceTypes.list().filter((t) => t.autoDetect);
  const realSubjects = (subjects ?? []).filter((s) => !s.is_stub);
  const subjectName = new Map((subjects ?? []).map((s) => [s.id, s.name_uk]));
  const topicRefs = (topics ?? []).map((t, i) => ({ ref: `t${i + 1}`, ...t }));
  const { system, user } = structurePrompt();
  const prompt = fillTemplate(user, {
    file_name: m.name,
    meta_title: m.title ?? "—",
    grade_hint: year?.grade != null ? String(year.grade) : "—",
    kinds: kinds.map((k) => `${k.key} — ${k.titleUk}`).join("\n"),
    subjects: realSubjects.map((s) => `${s.code} — ${s.name_uk}`).join("\n") || "—",
    existing_topics: topicRefs.map((t) => `${t.ref} — ${subjectName.get(t.subject_id) ?? "?"} — ${t.title}`).join("\n") || "—",
    // EPUB chapter titles are part of the outline (page labels).
    toc: "—",
    outline: buildOutline([...pages.values()].sort((a, b) => a.page - b.page)),
  });

  await patchMaterial(scope, materialId, { progress: { step: "structure" } });
  let answer;
  try {
    const res = await callStructured(
      "indexing_structure",
      { system, prompt, schema: buildStructureSchema(kinds.map((k) => k.key), [...realSubjects.map((s) => s.code)]) },
      { familyId, ref: { table: "materials", id: materialId } },
    );
    answer = res.result;
  } catch (e) {
    if (e instanceof BudgetBlockedError) {
      await patchMaterial(scope, materialId, { status: "deferred", status_detail: "budget_deferred" });
      return;
    }
    throw e;
  }

  const kind = m.kind_manual ? m.kind : answer.kind;
  const subjectId = m.subject_manual
    ? m.subject_id
    : (realSubjects.find((s) => s.code === answer.subject_code)?.id ?? null);
  const grade = m.grade ?? answer.grade ?? null;
  const strategy = sourceTypes.get(kind)?.structureStrategy ?? "contents";
  const sections = normalizeSections(answer, strategy, m.page_count ?? pages.size);

  // Sections (keep manual ones, keep identities by title).
  const { data: oldSections } = await scope
    .select("material_sections", "id, title, manual_override")
    .eq("material_id", materialId)
    .returns<{ id: string; title: string; manual_override: boolean }[]>();
  const sectionMerge = mergeByTitle(oldSections ?? [], sections);
  const sectionIds: string[] = [];
  for (const [i, s] of sections.entries()) {
    const step = sectionMerge.plan[i]!;
    const row = { title: s.title, page_from: s.page_from, page_to: s.page_to, sort_order: i };
    if (step.action === "insert") {
      const { data, error } = await scope.client
        .from("material_sections")
        .insert({ ...row, owner_family_id: familyId, material_id: materialId })
        .select("id")
        .single<{ id: string }>();
      if (error) throw new Error(`section insert failed: ${error.message}`);
      sectionIds.push(data.id);
    } else {
      if (step.action === "update") await scope.update("material_sections", row).eq("id", step.id!);
      sectionIds.push(step.id!);
    }
  }
  if (sectionMerge.remove.length) await scope.delete("material_sections").in("id", sectionMerge.remove);

  // Topics (textbooks with a subject only).
  const { data: oldTopics } = await scope
    .select("topics", "id, title, manual_override")
    .eq("material_id", materialId)
    .returns<{ id: string; title: string; manual_override: boolean }[]>();
  const incomingTopics =
    strategy === "textbook" && subjectId
      ? sections.flatMap((s, si) => s.topics.map((t) => ({ ...t, sectionId: sectionIds[si]! })))
      : [];
  const topicMerge = mergeByTitle(oldTopics ?? [], incomingTopics);
  const topicIdByTitle = new Map<string, string>();
  for (const [i, t] of incomingTopics.entries()) {
    const step = topicMerge.plan[i]!;
    const row = {
      title: t.title,
      page_from: t.page_from,
      page_to: t.page_to,
      section_id: t.sectionId,
      sort_order: i,
      subject_id: subjectId,
      grade: grade ?? year?.grade ?? null,
      curriculum_version: m.curriculum_version,
    };
    if (step.action === "insert") {
      const { data, error } = await scope.client
        .from("topics")
        .insert({ ...row, owner_family_id: familyId, material_id: materialId })
        .select("id")
        .single<{ id: string }>();
      if (error) throw new Error(`topic insert failed: ${error.message}`);
      topicIdByTitle.set(t.title, data.id);
    } else {
      if (step.action === "update") await scope.update("topics", row).eq("id", step.id!);
      topicIdByTitle.set(t.title, step.id!);
    }
  }
  if (topicMerge.remove.length) await scope.delete("topics").in("id", topicMerge.remove);

  // Topic dependencies proposed by the model (the parent's ones are kept).
  const ownTopicIds = [...topicIdByTitle.values()];
  if (ownTopicIds.length) {
    await scope.delete("topic_dependencies").eq("source", "ai").in("topic_id", ownTopicIds);
    const deps = answer.dependencies
      .map((d) => ({ topic_id: topicIdByTitle.get(d.topic.trim()), depends_on_id: topicIdByTitle.get(d.depends_on.trim()) }))
      .filter((d): d is { topic_id: string; depends_on_id: string } => !!d.topic_id && !!d.depends_on_id && d.topic_id !== d.depends_on_id);
    if (deps.length) await scope.upsert("topic_dependencies", deps.map((d) => ({ ...d, source: "ai" })), "topic_id,depends_on_id");
  }

  // Links of any other book to existing topics (US-2.6 KP-1), unless the parent set them.
  if (!m.topics_manual) {
    await scope.delete("material_topic_links").eq("material_id", materialId).eq("source", "ai");
    const refs = new Map(topicRefs.map((t) => [t.ref, t.id]));
    const links = strategy === "textbook" ? [] : [...new Set(answer.related_topics)].map((r) => refs.get(r)).filter((x): x is string => !!x);
    if (links.length) {
      await scope.upsert("material_topic_links", links.map((topic_id) => ({ material_id: materialId, topic_id, source: "ai" })), "material_id,topic_id");
    }
  }

  const { error: assignErr } = await scope.client.rpc("assign_chunk_structure", { p_family_id: familyId, p_material_id: materialId });
  if (assignErr) throw new Error(`assign_chunk_structure failed: ${assignErr.message}`);

  await patchMaterial(scope, materialId, {
    kind,
    subject_id: subjectId,
    grade,
    title: m.title ?? (answer.title.trim() || null),
    status: "ready",
    status_detail: strategy === "textbook" && !subjectId ? "no_subject" : null,
    indexed_at: new Date().toISOString(),
    progress: {},
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
async function giveUp(job: JobRow, e: unknown): Promise<void> {
  const materialId = job.payload.materialId;
  if (typeof materialId !== "string") return;
  await patchMaterial(forFamily(job.family_id), materialId, {
    status: "error",
    status_detail: errorCodeOf(e),
    progress: {},
  });
}

let registered = false;
export function registerIngestJobs(): void {
  if (registered) return;
  registered = true;
  const common = { isRetryable: isRetryableIngestError, onGiveUp: giveUp };
  registerJobHandler(JOB.sync, {
    run: async (job) => {
      await syncDriveFolder(job.family_id);
    },
    isRetryable: isRetryableIngestError,
  });
  registerJobHandler(JOB.extract, { ...common, run: runExtract });
  registerJobHandler(JOB.ocr, { ...common, run: runOcr });
  registerJobHandler(JOB.embed, { ...common, run: runEmbed });
  registerJobHandler(JOB.structure, { ...common, run: runStructure });
}
