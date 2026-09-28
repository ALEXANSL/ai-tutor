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
import { DriveError, downloadFile, listFolderFiles, type DriveFile } from "../drive/google";
import { getConfiguredDriveFolders, getDriveToken } from "../drive/service";
import { enqueueJob, registerJobHandler, type JobRow } from "../jobs/runner";
import { warmAheadForSubject } from "../lessons/warmup";
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
  buildOutlineSchema,
  buildSectionSchema,
  buildSectionText,
  fillTemplate,
  mergeByTitle,
  normalizeOutlineSections,
  normalizeProblems,
  normalizeSectionTopics,
  splitPrompt,
  type PageText,
} from "./structure";
import { planManualBatchSync, planSync, type KnownMaterial } from "./sync-plan";
import { chunkUnits, type ExtractedUnit } from "./text";

/**
 * Universal ingest pipeline (docs/02 9.1, ADR-008, ADR-017):
 * drive.sync → ingest.extract → ingest.embed → ingest.structure_outline →
 * N × ingest.structure_section (ADR-032 — one section at a time, not the
 * whole book in a single call; see the ADR for why).
 * Every step is a separate job (≤ 300 s), resumable after a crash.
 */
export const JOB = {
  sync: "drive.sync",
  extract: "ingest.extract",
  ocr: "ingest.ocr",
  embed: "ingest.embed",
  /** ADR-032 pass 1: book classification + section boundaries only. */
  structureOutline: "ingest.structure_outline",
  /** ADR-032 pass 2: one job per section, payload `{ materialId, sectionId }`. */
  structureSection: "ingest.structure_section",
  /** Legacy job type from before ADR-032 — kept registered (mapped to the
   * new outline pass) so any job already queued at deploy time still
   * completes instead of failing with "no handler". Never enqueued by new code. */
  structureLegacy: "ingest.structure",
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

export async function patchMaterial(scope: FamilyScope, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await scope.update("materials", patch).eq("id", id);
  if (error) throw new Error(`materials update failed: ${error.message}`);
}

const dedupe = (type: string, materialId: string) => `${type}:${materialId}`;

export async function enqueueStep(familyId: string, type: string, materialId: string, extra: Record<string, unknown> = {}) {
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
  /** ADR-031 §3.8: new ZIP batches detected (not yet parsed — the parent runs "Розібрати архів" per batch). */
  manualBatchesAdded: number;
}

export async function syncDriveFolder(familyId: string): Promise<SyncSummary> {
  const scope = forFamily(familyId);
  const folders = await getConfiguredDriveFolders(familyId);
  if (!folders.length) throw new DriveError("no Drive folder is configured", null, "not_configured");
  const token = await getDriveToken();
  const accessToken = await token();
  // ADR-024 (docs/02 10.3): the same conveyor scans BOTH the manually-shared
  // materials folder and, once configured, the app-owned "Мої книги" uploads
  // folder — merged (de-duplicated by id) into one file list.
  const byId = new Map<string, DriveFile & { format: "pdf" | "epub" | "zip" }>();
  let skipped = 0;
  for (const folder of folders) {
    const res = await listFolderFiles(folder.folderId, accessToken);
    skipped += res.skipped;
    for (const f of res.files) byId.set(f.id, f);
  }
  const allFiles = [...byId.values()];
  // ADR-031 §3.8: a ZIP never becomes a `materials` row directly — it goes
  // through `manual_import_batches` instead (0..N rows only at commit).
  const files = allFiles.filter((f): f is DriveFile & { format: "pdf" | "epub" } => f.format !== "zip");
  const zipFiles = allFiles.filter((f) => f.format === "zip");
  const { data: known, error } = await scope
    .select("materials", "id, drive_file_id, name, drive_md5, drive_modified_time, status, status_detail")
    .returns<KnownMaterial[]>();
  if (error) throw new Error(`materials select failed: ${error.message}`);
  const budget = await getBudget(familyId);
  const plan = planSync(known ?? [], files, { budgetBlocked: budgetBlocks(budget.state) });

  let manualBatchesAdded = 0;
  if (zipFiles.length) {
    const { data: knownBatches, error: batchErr } = await scope
      .select("manual_import_batches", "id, drive_file_id, drive_md5")
      .returns<{ id: string; drive_file_id: string; drive_md5: string | null }[]>();
    if (batchErr) throw new Error(`manual_import_batches select failed: ${batchErr.message}`);
    const batchPlan = planManualBatchSync(knownBatches ?? [], zipFiles);
    if (batchPlan.insert.length) {
      const { error: insErr } = await scope.insert(
        "manual_import_batches",
        batchPlan.insert.map((b) => ({ drive_file_id: b.driveFileId, name: b.name, drive_md5: b.driveMd5, status: "pending_review", plan: {} })),
      );
      if (insErr) throw new Error(`manual_import_batches insert failed: ${insErr.message}`);
      manualBatchesAdded = batchPlan.insert.length;
    }
    for (const r of batchPlan.resetForReparse) {
      await scope.update("manual_import_batches", { drive_md5: r.driveMd5, status: "pending_review", plan: {}, error_detail: null }).eq("id", r.id);
    }
  }

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
    manualBatchesAdded,
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

export interface UploadedBookFile {
  id: string;
  name: string;
  mimeType: string;
  format: "pdf" | "epub";
  size: number | null;
  modifiedTime: string | null;
  md5Checksum: string | null;
}

/**
 * Inserts the `materials` row for a book the parent just uploaded from the
 * browser (ADR-024 §5, US-2.7 КП-5): the server already has
 * `drive_file_id`/`name`/`mime`/`format` from the Drive `files.create`
 * response, so indexing is queued immediately — no wait for the next manual
 * "Перевірити папку" or the daily `pg_cron` sync.
 */
export async function ingestUploadedMaterial(
  familyId: string,
  file: UploadedBookFile,
): Promise<{ materialId: string; status: "queued" | "deferred" }> {
  const scope = forFamily(familyId);
  const budget = await getBudget(familyId);
  const status = budgetBlocks(budget.state) ? "deferred" : "queued";
  const { data, error } = await scope.client
    .from("materials")
    .insert({
      owner_family_id: familyId,
      drive_file_id: file.id,
      name: file.name,
      mime: file.mimeType,
      format: file.format,
      drive_md5: file.md5Checksum,
      drive_modified_time: file.modifiedTime,
      size_bytes: file.size,
      status,
      status_detail: status === "deferred" ? "budget_deferred" : null,
      progress: {},
    })
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(`materials insert failed: ${error.message}`);
  if (status === "queued") await enqueueStep(familyId, JOB.extract, data.id);
  return { materialId: data.id, status };
}

// ---------------------------------------------------------------------------
// ingest.extract
// ---------------------------------------------------------------------------
export interface MaterialRow {
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

/**
 * Chunks the merged units, saves them and hands off to `ingest.embed` — the
 * shared tail of a text extraction and an OCR run (D-54), also reused by the
 * manual-batch-import commit (ADR-031 §3.6, `manual-batch-pipeline.ts`) for
 * its own already-clean `ExtractedUnit[]` (no download/extract step of its
 * own — the parent's ZIP already has the text).
 */
export async function finishExtraction(
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
  const token = await getDriveToken();
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

  // ADR-031 §3: a `format = 'manual'` row (batch ZIP import) has no
  // `sourceExtractors` entry on purpose — it is only ever produced, and only
  // ever re-produced, by `ingest.manual_batch_commit`, never by this job.
  if (m.format === "manual") {
    throw new IngestError("extract_failed", "manual batch-imported materials are not re-extracted here — re-run the batch import to update this subject's content");
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

  const token = await getDriveToken();
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
      // ADR-031 §3.6: a manual batch-import row already has its
      // sections/topics written directly by `applyManualStructure` at
      // commit time (no AI call) — once embedding is done there is nothing
      // left to structure, unlike the AI path below.
      if (m.format === "manual") {
        await patchMaterial(scope, materialId, { status: "ready", status_detail: null, indexed_at: new Date().toISOString(), progress: {} });
        return;
      }
      await patchMaterial(scope, materialId, { progress: { step: "structure", done: total, total } });
      await enqueueStep(familyId, JOB.structureOutline, materialId);
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
// ingest.structure_outline / ingest.structure_section (ADR-032)
// ---------------------------------------------------------------------------
let outlinePromptCache: { system: string; user: string } | null = null;
function outlinePrompt(): { system: string; user: string } {
  outlinePromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "indexing_outline.md"), "utf8"));
  return outlinePromptCache;
}
let sectionPromptCache: { system: string; user: string } | null = null;
function sectionPrompt(): { system: string; user: string } {
  sectionPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "indexing_structure.md"), "utf8"));
  return sectionPromptCache;
}

/**
 * ADR-032: the book-level status a partway/finished structuring pass should
 * show. Recomputed from `material_sections.status` every time a section
 * finishes (success or final failure) — never assumed, so it stays correct
 * regardless of which section finishes first (sections run independently and
 * in any order once queued). `ready_partial` (new terminal status, needs the
 * matching migration) is used only once EVERY section has either succeeded
 * or exhausted its own retries and at least one of each is true; a book
 * whose every section failed is `error` (same as a failed outline pass) —
 * nothing usable came out of it.
 */
async function finalizeMaterialStatus(scope: FamilyScope, materialId: string): Promise<void> {
  const [{ data: sections }, { data: mat }] = await Promise.all([
    scope.select("material_sections", "status").eq("material_id", materialId).returns<{ status: string }[]>(),
    scope.select("materials", "kind, subject_id").eq("id", materialId).maybeSingle<{ kind: string; subject_id: string | null }>(),
  ]);
  const rows = sections ?? [];
  const total = rows.length;
  const doneCount = rows.filter((s) => s.status === "ready" || s.status === "error").length;
  if (total > 0 && doneCount < total) {
    await patchMaterial(scope, materialId, { progress: { step: "structure", sections_total: total, sections_done: doneCount } });
    return;
  }
  const anyError = rows.some((s) => s.status === "error");
  const anyReady = rows.some((s) => s.status === "ready");
  const status = total === 0 || !anyError ? "ready" : anyReady ? "ready_partial" : "error";
  const strategy = mat ? (sourceTypes.get(mat.kind)?.structureStrategy ?? "contents") : "contents";
  const noSubject = strategy === "textbook" && !!mat && !mat.subject_id;
  await patchMaterial(scope, materialId, {
    status,
    status_detail: status === "error" ? "ai_failed" : status === "ready_partial" ? "ready_partial" : noSubject ? "no_subject" : null,
    indexed_at: new Date().toISOString(),
    progress: {},
  });
}

/**
 * ADR-032 pass 1 (`ingest.structure_outline`): a small, reliable call —
 * book classification + top-level section BOUNDARIES only (no topics, no
 * exercises, no dependencies — those are each section's own job below).
 * Writes `materials.kind/subject_id/grade/title` and `material_sections`
 * rows right away, then fans out one `ingest.structure_section` job PER
 * section, all enqueued at once (not one after another) so the existing
 * cron/kick mechanism can pick them up in parallel across ticks.
 */
async function runStructureOutline(job: JobRow): Promise<void> {
  const familyId = job.family_id;
  const materialId = String(job.payload.materialId);
  const scope = forFamily(familyId);
  const m = await loadMaterial(scope, materialId);
  if (!m || m.status === "removed") return;
  if (await deferIfBudget(scope, familyId, materialId)) return;

  const [{ data: chunkRows }, { data: subjects }, { data: year }] = await Promise.all([
    scope
      .select("chunks", "page, locator, text, ordinal")
      .eq("material_id", materialId)
      .order("ordinal")
      .limit(20000)
      .returns<{ page: number; locator: string | null; text: string }[]>(),
    scope.select("subjects", "id, code, name_uk, is_stub").returns<{ id: string; code: string; name_uk: string; is_stub: boolean }[]>(),
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
  const { system, user } = outlinePrompt();
  const prompt = fillTemplate(user, {
    file_name: m.name,
    meta_title: m.title ?? "—",
    grade_hint: year?.grade != null ? String(year.grade) : "—",
    kinds: kinds.map((k) => `${k.key} — ${k.titleUk}`).join("\n"),
    subjects: realSubjects.map((s) => `${s.code} — ${s.name_uk}`).join("\n") || "—",
    // EPUB chapter titles are part of the outline (page labels).
    toc: "—",
    outline: buildOutline([...pages.values()].sort((a, b) => a.page - b.page)),
  });

  await patchMaterial(scope, materialId, { progress: { step: "structure" } });
  let answer;
  try {
    const res = await callStructured(
      "indexing_outline",
      { system, prompt, schema: buildOutlineSchema(kinds.map((k) => k.key), [...realSubjects.map((s) => s.code)]) },
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
  const subjectId = m.subject_manual ? m.subject_id : (realSubjects.find((s) => s.code === answer.subject_code)?.id ?? null);
  const grade = m.grade ?? answer.grade ?? null;
  const sections = normalizeOutlineSections(answer, m.page_count ?? pages.size);

  // Sections (keep manual ones, keep identities by title) — every section is
  // re-queued for its own structuring pass below regardless of
  // manual_override: that flag protects only the section's OWN title/pages,
  // not the topics/exercises inside it (same split as before ADR-032).
  const { data: oldSections } = await scope
    .select("material_sections", "id, title, manual_override")
    .eq("material_id", materialId)
    .returns<{ id: string; title: string; manual_override: boolean }[]>();
  const sectionMerge = mergeByTitle(oldSections ?? [], sections);
  const sectionIds: string[] = [];
  for (const [i, s] of sections.entries()) {
    const step = sectionMerge.plan[i]!;
    if (step.action === "insert") {
      const { data, error } = await scope.client
        .from("material_sections")
        .insert({
          title: s.title,
          page_from: s.page_from,
          page_to: s.page_to,
          sort_order: i,
          status: "pending",
          status_detail: null,
          owner_family_id: familyId,
          material_id: materialId,
        })
        .select("id")
        .single<{ id: string }>();
      if (error) throw new Error(`section insert failed: ${error.message}`);
      sectionIds.push(data.id);
    } else if (step.action === "update") {
      await scope
        .update("material_sections", { title: s.title, page_from: s.page_from, page_to: s.page_to, sort_order: i, status: "pending", status_detail: null })
        .eq("id", step.id!);
      sectionIds.push(step.id!);
    } else {
      // "keep" (manual_override): title/pages untouched, but still queued.
      await scope.update("material_sections", { status: "pending", status_detail: null }).eq("id", step.id!);
      sectionIds.push(step.id!);
    }
  }
  if (sectionMerge.remove.length) await scope.delete("material_sections").in("id", sectionMerge.remove);

  // Related-topic links (non-textbook types, US-2.6 KP-1) are rebuilt fully
  // across all sections on every (re)index — clear once here, each section
  // job below only ever upserts (never deletes), so sections finishing in
  // any order never erase each other's contribution.
  if (!m.topics_manual) await scope.delete("material_topic_links").eq("material_id", materialId).eq("source", "ai");

  await patchMaterial(scope, materialId, {
    kind,
    subject_id: subjectId,
    grade,
    title: m.title ?? (answer.title.trim() || null),
    status: "indexing",
    status_detail: null,
    progress: { step: "structure", sections_total: sectionIds.length, sections_done: 0 },
  });

  if (sectionIds.length === 0) {
    await finalizeMaterialStatus(scope, materialId);
    return;
  }
  for (const sectionId of sectionIds) {
    await enqueueJob(familyId, JOB.structureSection, { materialId, sectionId }, { dedupeKey: `${JOB.structureSection}:${materialId}:${sectionId}` });
  }
}

interface SectionRow {
  id: string;
  title: string;
  page_from: number | null;
  page_to: number | null;
  sort_order: number;
}

/**
 * ADR-032 pass 2 (`ingest.structure_section`): one job per section, run
 * independently (own retry/backoff, own final status) — a section that keeps
 * failing never blocks the rest of the book. Input is the section's own
 * FULL, uncompressed page text (not the whole-book 120k-char extract), so
 * both the risk of an oversized output AND the risk of the model having to
 * "guess" from a compressed extract drop together.
 */
async function runStructureSection(job: JobRow): Promise<void> {
  const familyId = job.family_id;
  const materialId = String(job.payload.materialId);
  const sectionId = String(job.payload.sectionId);
  const scope = forFamily(familyId);
  const m = await loadMaterial(scope, materialId);
  if (!m || m.status === "removed") return;
  if (await deferIfBudget(scope, familyId, materialId)) return;

  const { data: section } = await scope
    .select("material_sections", "id, title, page_from, page_to, sort_order")
    .eq("id", sectionId)
    .maybeSingle<SectionRow>();
  if (!section) return; // a later re-index removed this section before this job ran

  let chunkQuery = scope.select("chunks", "page, locator, text, ordinal").eq("material_id", materialId).order("ordinal").limit(20000);
  if (section.page_from != null) chunkQuery = chunkQuery.gte("page", section.page_from);
  if (section.page_to != null) chunkQuery = chunkQuery.lte("page", section.page_to);
  const [{ data: chunkRows }, { data: topics }, { data: subjectRows }, { data: year }] = await Promise.all([
    chunkQuery.returns<{ page: number; locator: string | null; text: string }[]>(),
    scope
      .select("topics", "id, title, subject_id, material_id")
      .or(`material_id.is.null,material_id.neq.${materialId}`)
      .order("sort_order")
      .limit(300)
      .returns<{ id: string; title: string; subject_id: string; material_id: string | null }[]>(),
    scope.select("subjects", "id, name_uk").returns<{ id: string; name_uk: string }[]>(),
    scope.select("academic_years", "grade").eq("status", "active").maybeSingle<{ grade: number }>(),
  ]);

  await scope.update("material_sections", { status: "indexing", status_detail: null }).eq("id", sectionId);

  const pages = new Map<number, PageText>();
  for (const c of chunkRows ?? []) {
    const p = pages.get(c.page) ?? { page: c.page, locator: c.locator, text: "" };
    p.text = p.text ? `${p.text}\n${c.text}` : c.text;
    pages.set(c.page, p);
  }
  const sortedPages = [...pages.values()].sort((a, b) => a.page - b.page);
  const kindMeta = sourceTypes.get(m.kind);
  const strategy = kindMeta?.structureStrategy ?? "contents";
  const subjectName = new Map((subjectRows ?? []).map((s) => [s.id, s.name_uk]));
  const topicRefs = (topics ?? []).map((t, i) => ({ ref: `t${i + 1}`, ...t }));
  const rangeLabel =
    section.page_from != null ? `стор. ${section.page_from}${section.page_to != null && section.page_to !== section.page_from ? `–${section.page_to}` : ""}` : "—";
  const { system, user } = sectionPrompt();
  const prompt = fillTemplate(user, {
    file_name: m.name,
    meta_title: m.title ?? "—",
    kind_title: kindMeta?.titleUk ?? m.kind,
    section_title: section.title,
    section_range: rangeLabel,
    existing_topics: topicRefs.map((t) => `${t.ref} — ${subjectName.get(t.subject_id) ?? "?"} — ${t.title}`).join("\n") || "—",
    section_text: buildSectionText(sortedPages),
  });

  let answer;
  try {
    const res = await callStructured(
      "indexing_structure",
      { system, prompt, schema: buildSectionSchema() },
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

  const subjectId = m.subject_id;
  const pageCount = m.page_count ?? sortedPages.length;
  const topicsNorm = strategy === "textbook" && subjectId ? normalizeSectionTopics(answer, strategy, pageCount, section.page_to) : [];

  // Topics: mergeByTitle scoped to THIS section (ADR-032) — a topic can
  // never merge with one from a different section on re-index, unlike the
  // whole-book scoping used before ADR-032.
  const { data: oldTopics } = await scope
    .select("topics", "id, title, manual_override")
    .eq("material_id", materialId)
    .eq("section_id", sectionId)
    .returns<{ id: string; title: string; manual_override: boolean }[]>();
  const topicMerge = mergeByTitle(oldTopics ?? [], topicsNorm);
  const topicIdByTitle = new Map<string, string>();
  const baseOrder = section.sort_order * 1000;
  for (const [i, t] of topicsNorm.entries()) {
    const step = topicMerge.plan[i]!;
    const row = {
      title: t.title,
      page_from: t.page_from,
      page_to: t.page_to,
      section_id: sectionId,
      sort_order: baseOrder + i,
      subject_id: subjectId,
      grade: m.grade ?? year?.grade ?? null,
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

  // Dependencies between THIS section's own topics (prompt rule 5 — the
  // model is only ever shown this section's topics, so `depends_on` can
  // never name a topic outside `ownTopicIds`).
  const ownTopicIds = [...topicIdByTitle.values()];
  if (ownTopicIds.length) {
    await scope.delete("topic_dependencies").eq("source", "ai").in("topic_id", ownTopicIds);
    const deps = answer.dependencies
      .map((d) => ({ topic_id: topicIdByTitle.get(d.topic.trim()), depends_on_id: topicIdByTitle.get(d.depends_on.trim()) }))
      .filter((d): d is { topic_id: string; depends_on_id: string } => !!d.topic_id && !!d.depends_on_id && d.topic_id !== d.depends_on_id);
    if (deps.length) await scope.upsert("topic_dependencies", deps.map((d) => ({ ...d, source: "ai" })), "topic_id,depends_on_id");
  }

  // This section's related-topic links (non-textbook types) — additive only
  // (see the outline pass's one-time clear above), unless the parent set them.
  if (!m.topics_manual) {
    const refs = new Map(topicRefs.map((t) => [t.ref, t.id]));
    const links = strategy === "textbook" ? [] : [...new Set(answer.related_topics)].map((r) => refs.get(r)).filter((x): x is string => !!x);
    if (links.length) {
      await scope.upsert("material_topic_links", links.map((topic_id) => ({ material_id: materialId, topic_id, source: "ai" })), "material_id,topic_id");
    }
  }

  // ADR-029 (US-2.8): this section's numbered exercises — delete+insert
  // scoped to `material_id + section_id` (not the whole material, ADR-032),
  // so sections finishing in any order never clobber each other's exercises.
  await scope.delete("material_problems").eq("material_id", materialId).eq("section_id", sectionId);
  const problems = strategy === "textbook" ? normalizeProblems(answer, strategy, pageCount) : [];
  if (problems.length) {
    const { error: probErr } = await scope.insert(
      "material_problems",
      problems.map((p) => ({ material_id: materialId, section_id: sectionId, number: p.number, page: p.page })),
    );
    if (probErr) throw new Error(`material_problems insert failed: ${probErr.message}`);
  }
  // Whole-material scan (ADR-032: "trochu надлишковий по обчисленню в БД,
  // але дешевий, без ШІ-вартості" — idempotent, safe to call once per
  // finished section rather than only once per book).
  const { error: assignProbErr } = await scope.client.rpc("assign_problem_structure", { p_family_id: familyId, p_material_id: materialId });
  if (assignProbErr) throw new Error(`assign_problem_structure failed: ${assignProbErr.message}`);
  const { error: assignErr } = await scope.client.rpc("assign_chunk_structure", { p_family_id: familyId, p_material_id: materialId });
  if (assignErr) throw new Error(`assign_chunk_structure failed: ${assignErr.message}`);

  await scope.update("material_sections", { status: "ready", status_detail: null }).eq("id", sectionId);
  await finalizeMaterialStatus(scope, materialId);

  // ADR-023 §Частина 3.1 (D-103) + ADR-032: the parent's own act of indexing
  // a textbook for an already-active, non-stub subject is itself the
  // "positive" signal — no separate manual `is_current` click required. Now
  // fired per FINISHED SECTION (not once for the whole book, ADR-032's main
  // point): topics of section 1 start warming up while section 5 is still
  // being structured. `warmAheadForSubject` re-checks `subjects.active`/
  // `is_stub` itself; never blocks or fails the ingest job either way.
  if (strategy === "textbook" && subjectId && topicIdByTitle.size > 0) {
    const anchorTopicId = [...topicIdByTitle.values()][0];
    await warmAheadForSubject(familyId, subjectId, { anchorTopicId }).catch((e: Error) =>
      console.error(`warm-ahead after ingest.structure_section failed: ${e.message}`),
    );
  }
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

/** ADR-032: a section that exhausted its own retries only fails ITSELF — the
 * book's overall status is recomputed (may still land on `ready_partial`,
 * never a blanket `error` for the other, successful sections). */
async function giveUpSection(job: JobRow, e: unknown): Promise<void> {
  const materialId = job.payload.materialId;
  const sectionId = job.payload.sectionId;
  if (typeof materialId !== "string" || typeof sectionId !== "string") return;
  const scope = forFamily(job.family_id);
  await scope.update("material_sections", { status: "error", status_detail: errorCodeOf(e) }).eq("id", sectionId);
  await finalizeMaterialStatus(scope, materialId);
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
  registerJobHandler(JOB.structureOutline, { ...common, run: runStructureOutline });
  registerJobHandler(JOB.structureSection, { isRetryable: isRetryableIngestError, onGiveUp: giveUpSection, run: runStructureSection });
  // Legacy alias (ADR-032): any `ingest.structure` job still queued from
  // before this deploy runs the new outline pass instead of failing with
  // "no handler" — it then fans out into `ingest.structure_section` jobs
  // itself, same as a fresh `ingest.structure_outline` job would.
  registerJobHandler(JOB.structureLegacy, { ...common, run: runStructureOutline });
}
