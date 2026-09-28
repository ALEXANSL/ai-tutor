"use server";

import { revalidatePath } from "next/cache";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { getManualImportBatch, listManualImportBatches, type ManualImportBatchItem } from "@/server/books/queries";
import { startManualBatchCommit, startManualBatchPreview, type FolderDecision, type StoredPlan } from "@/server/ingest/manual-batch-pipeline";
import { kickJobs } from "@/server/jobs/kick";
import type { FormState } from "./state";

/**
 * "Розібрати архів" / екран підтвердження / "Імпортувати" (ADR-031 §3.8).
 * Every action re-checks the parent role on the server, same as the rest of
 * "Мої книги".
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = uk.parent.manualImport;

function uuidOf(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "");
  return UUID.test(v) ? v : null;
}

/** "Розібрати архів": queues the parse-only preview job for one already-detected ZIP batch. */
export async function previewManualBatchAction(formData: FormData): Promise<void> {
  const { familyId } = await requireParentAccess();
  const batchId = uuidOf(formData, "batchId");
  if (!batchId) return;
  await startManualBatchPreview(familyId, batchId);
  kickJobs();
  revalidatePath("/parent/books/import", "layout");
}

/** Polled while a batch is being parsed/imported — keeps the queue moving without cron (same pattern as `pollIndexingAction`). */
export async function pollManualBatchesAction(): Promise<ManualImportBatchItem[]> {
  const { familyId } = await requireParentAccess();
  const batches = await listManualImportBatches(familyId);
  const notYetParsed = (b: ManualImportBatchItem) => b.status === "pending_review" && (!b.plan || Object.keys(b.plan as object).length === 0);
  if (batches.some((b) => b.status === "importing" || notYetParsed(b))) kickJobs();
  return batches;
}

/**
 * "Імпортувати" (confirm screen): reads the parent's per-folder decision
 * (`action_<slug>` = subject|create_subject|skip, plus `subjectId_<slug>` /
 * `newSubjectName_<slug>`) for every folder the preview found, and queues
 * the commit job — the only step that writes `materials`/`chunks`/etc
 * (ADR-031 §3.6/§3.8).
 */
export async function commitManualBatchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const batchId = uuidOf(formData, "batchId");
  if (!batchId) return { status: "error", message: uk.common.error };
  const batch = await getManualImportBatch(familyId, batchId);
  if (!batch || batch.status !== "pending_review") return { status: "error", message: uk.common.error };
  const plan = batch.plan as StoredPlan | null;
  if (!plan || plan.form !== "batch") return { status: "error", message: uk.common.error };

  const decisions: Record<string, FolderDecision> = {};
  for (const folder of plan.folders) {
    if (folder.wholeFolderRejected || !folder.parseOk) continue; // never offered a decision — always rejected/skipped
    const action = String(formData.get(`action_${folder.slug}`) ?? "skip");
    if (action === "subject") {
      const subjectId = String(formData.get(`subjectId_${folder.slug}`) ?? "");
      if (!UUID.test(subjectId)) continue; // treated as "skip" — never guess a subject
      decisions[folder.slug] = { action: "subject", subjectId };
    } else if (action === "create_subject") {
      const newSubjectName = String(formData.get(`newSubjectName_${folder.slug}`) ?? "").trim();
      if (!newSubjectName) continue;
      decisions[folder.slug] = { action: "create_subject", newSubjectName };
    }
    // else: "skip" (explicit or unrecognised) — folder left out of `decisions`, `commitFolder` treats a missing entry as skip.
  }

  await startManualBatchCommit(familyId, batchId, decisions);
  kickJobs();
  revalidatePath("/parent/books/import", "layout");
  revalidatePath(`/parent/books/import/${batchId}`, "layout");
  return { status: "ok", message: t.confirm.started };
}
