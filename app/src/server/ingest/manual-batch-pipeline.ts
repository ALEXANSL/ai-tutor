import "server-only";
import { forFamily, type FamilyScope } from "../db/family-scope";
import { downloadFile } from "../drive/google";
import { getDriveToken } from "../drive/service";
import { enqueueJob, registerJobHandler, type JobRow } from "../jobs/runner";
import { warmAheadForSubject } from "../lessons/warmup";
import {
  buildFolderPlan,
  buildSectionsForImport,
  buildUnitsForImport,
  type FolderParseResult,
  type FolderPlan,
  NEW_SUBJECT_NAME_HINTS,
  parseManualBatchZip,
} from "./manual-batch";
import { errorCodeOf, finishExtraction, isRetryableIngestError, patchMaterial } from "./pipeline";
import { mergeByTitle, type NormalizedSection } from "./structure";

/**
 * ADR-031 Частина 3: the two jobs behind "Розібрати архів" / "Імпортувати"
 * for a batch manual-import ZIP (several subject-folders in one Drive file).
 * `ingest.manual_batch_preview` NEVER writes to `materials`/`chunks`/etc — it
 * only fills in `manual_import_batches.plan` (side-effect-free, safe to
 * re-run). Only `ingest.manual_batch_commit` writes real rows, and only for
 * folders the parent confirmed on the review screen.
 */
export const MANUAL_BATCH_JOB = {
  preview: "ingest.manual_batch_preview",
  commit: "ingest.manual_batch_commit",
} as const;

interface BatchRow {
  id: string;
  drive_file_id: string;
  name: string;
  status: string;
}

async function loadBatch(scope: FamilyScope, id: string): Promise<BatchRow | null> {
  const { data } = await scope.select("manual_import_batches", "id, drive_file_id, name, status").eq("id", id).maybeSingle<BatchRow>();
  return data ?? null;
}

async function patchBatch(scope: FamilyScope, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await scope.update("manual_import_batches", patch).eq("id", id);
  if (error) throw new Error(`manual_import_batches update failed: ${error.message}`);
}

async function downloadAndParse(driveFileId: string) {
  const token = await getDriveToken();
  const bytes = await downloadFile(driveFileId, await token());
  return parseManualBatchZip(bytes);
}

// ---------------------------------------------------------------------------
// ingest.manual_batch_preview — parse only, NO database writes beyond the
// batch row's own `plan`/`status` (ADR-031 §3.8).
// ---------------------------------------------------------------------------
export interface StoredPlan {
  form: "single_manifest" | "empty" | "batch";
  folders: FolderPlan[];
}

async function runManualBatchPreview(job: JobRow): Promise<void> {
  const familyId = job.family_id;
  const batchId = String(job.payload.batchId);
  const scope = forFamily(familyId);
  const batch = await loadBatch(scope, batchId);
  if (!batch) return;

  let parsed;
  try {
    parsed = await downloadAndParse(batch.drive_file_id);
  } catch (e) {
    await patchBatch(scope, batchId, { status: "error", error_detail: errorCodeOf(e) });
    return;
  }

  if (parsed.form !== "batch") {
    // Форма (а) (Частина 1(Б), single manifest.json) or an empty/unrecognised
    // ZIP — not this import path; surfaced as an error, never guessed at.
    await patchBatch(scope, batchId, { status: "error", error_detail: parsed.form === "single_manifest" ? "single_manifest_not_supported" : "empty_zip" });
    return;
  }

  const plan: StoredPlan = { form: "batch", folders: parsed.folders.map(buildFolderPlan) };
  await patchBatch(scope, batchId, { status: "pending_review", plan, error_detail: null });
}

// ---------------------------------------------------------------------------
// applyManualStructure (ADR-031 §3.6): sections/topics straight from
// `index.json`, no AI call — the manual-import twin of what
// `runStructureOutline`+`runStructureSection` do for the AI path, reusing
// the SAME `mergeByTitle` re-index-safety rules (manual parent edits via
// `updateTopicAction` are never clobbered by a later "Розібрати"+"Імпортувати").
// ---------------------------------------------------------------------------
async function applyManualStructure(
  scope: FamilyScope,
  familyId: string,
  materialId: string,
  sections: NormalizedSection[],
  meta: { subjectId: string; grade: number | null },
): Promise<void> {
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
        .insert({ title: s.title, page_from: s.page_from, page_to: s.page_to, sort_order: i, owner_family_id: familyId, material_id: materialId })
        .select("id")
        .single<{ id: string }>();
      if (error) throw new Error(`section insert failed: ${error.message}`);
      sectionIds.push(data.id);
    } else if (step.action === "update") {
      await scope.update("material_sections", { title: s.title, page_from: s.page_from, page_to: s.page_to, sort_order: i }).eq("id", step.id!);
      sectionIds.push(step.id!);
    } else {
      sectionIds.push(step.id!); // "keep" — manual_override, untouched
    }
  }
  if (sectionMerge.remove.length) await scope.delete("material_sections").in("id", sectionMerge.remove);

  const baseOrder = (i: number) => i * 1000;
  for (const [i, s] of sections.entries()) {
    const sectionId = sectionIds[i]!;
    const { data: oldTopics } = await scope
      .select("topics", "id, title, manual_override")
      .eq("material_id", materialId)
      .eq("section_id", sectionId)
      .returns<{ id: string; title: string; manual_override: boolean }[]>();
    const topicMerge = mergeByTitle(oldTopics ?? [], s.topics);
    for (const [j, t] of s.topics.entries()) {
      const step = topicMerge.plan[j]!;
      const row = {
        title: t.title,
        page_from: t.page_from,
        page_to: t.page_to,
        section_id: sectionId,
        sort_order: baseOrder(i) + j,
        subject_id: meta.subjectId,
        grade: meta.grade,
        curriculum_version: null,
      };
      if (step.action === "insert") {
        const { error } = await scope.client.from("topics").insert({ ...row, owner_family_id: familyId, material_id: materialId });
        if (error) throw new Error(`topic insert failed: ${error.message}`);
      } else if (step.action === "update") {
        await scope.update("topics", row).eq("id", step.id!);
      }
    }
    if (topicMerge.remove.length) await scope.delete("topics").in("id", topicMerge.remove);
  }
}

// ---------------------------------------------------------------------------
// ingest.manual_batch_commit — the only step that writes `materials`/
// `chunks`/`material_sections`/`topics` (ADR-031 §3.6). Re-downloads and
// re-parses the SAME zip (deterministic) instead of trusting the preview's
// stored summary for the actual text — see `manual-batch.ts`.
// ---------------------------------------------------------------------------
export type FolderDecision = { action: "skip" } | { action: "subject"; subjectId: string } | { action: "create_subject"; newSubjectName: string };

export interface FolderCommitResult {
  slug: string;
  outcome: "imported" | "skipped_by_parent" | "rejected_scan" | "already_imported" | "error";
  topicsImported?: number;
  needsReviewCount?: number;
  imageOnlyCount?: number;
  errorDetail?: string;
}

async function resolveSubjectId(scope: FamilyScope, familyId: string, slug: string, decision: FolderDecision): Promise<string | null> {
  if (decision.action === "subject") {
    const { data } = await scope.select("subjects", "id").eq("id", decision.subjectId).eq("is_stub", false).maybeSingle<{ id: string }>();
    return data?.id ?? null;
  }
  if (decision.action === "create_subject") {
    const name = decision.newSubjectName.trim().slice(0, 120) || NEW_SUBJECT_NAME_HINTS[slug] || slug;
    const { data, error } = await scope.client.rpc("add_subject", { p_family_id: familyId, p_name_uk: name });
    const rows = data as { out_id: string; out_code: string }[] | null;
    if (error || !rows?.[0]) return null;
    return rows[0].out_id;
  }
  return null;
}

async function commitFolder(
  scope: FamilyScope,
  familyId: string,
  batch: BatchRow,
  folder: FolderParseResult,
  decision: FolderDecision,
  familyGrade: number | null,
): Promise<FolderCommitResult> {
  const folderPlan = buildFolderPlan(folder);
  if (!folderPlan.parseOk) return { slug: folder.slug, outcome: "error", errorDetail: folderPlan.parseErrors.join(",") };
  if (folderPlan.wholeFolderRejected) return { slug: folder.slug, outcome: "rejected_scan", imageOnlyCount: folderPlan.imageOnlyCount };
  if (decision.action === "skip") return { slug: folder.slug, outcome: "skipped_by_parent" };

  const { data: existing } = await scope
    .select("materials", "id, status")
    .eq("drive_file_id", batch.drive_file_id)
    .eq("source_subpath", folder.slug)
    .maybeSingle<{ id: string; status: string }>();
  if (existing && existing.status === "ready") {
    return { slug: folder.slug, outcome: "already_imported", topicsImported: folderPlan.importableCount };
  }

  const subjectId = await resolveSubjectId(scope, familyId, folder.slug, decision);
  if (!subjectId) return { slug: folder.slug, outcome: "error", errorDetail: "subject_resolution_failed" };

  const { data: subject } = await scope.select("subjects", "name_uk").eq("id", subjectId).maybeSingle<{ name_uk: string }>();
  const subjectName = subject?.name_uk ?? folder.slug;
  const materialFields = {
    drive_file_id: batch.drive_file_id,
    source_subpath: folder.slug,
    name: `${batch.name}/${folder.slug}`,
    title: `${subjectName} — адаптовані матеріали`,
    mime: "application/zip",
    format: "manual",
    kind: "textbook",
    kind_manual: true,
    subject_id: subjectId,
    subject_manual: true,
    topics_manual: false,
    status: "indexing",
    status_detail: null,
    progress: {},
  };

  let materialId: string;
  if (existing) {
    materialId = existing.id;
    await patchMaterial(scope, materialId, materialFields);
  } else {
    const { data, error } = await scope.client
      .from("materials")
      .insert({ ...materialFields, owner_family_id: familyId })
      .select("id")
      .single<{ id: string }>();
    if (error) return { slug: folder.slug, outcome: "error", errorDetail: `materials insert failed: ${error.message}` };
    materialId = data.id;
  }

  const sections = buildSectionsForImport(folder);
  const units = buildUnitsForImport(folder);
  try {
    await applyManualStructure(scope, familyId, materialId, sections, { subjectId, grade: familyGrade });
    await finishExtraction(scope, familyId, materialId, { page_count: null, char_count: units.reduce((n, u) => n + u.text.length, 0) }, units);
    const { error: assignErr } = await scope.client.rpc("assign_chunk_structure", { p_family_id: familyId, p_material_id: materialId });
    if (assignErr) throw new Error(`assign_chunk_structure failed: ${assignErr.message}`);
  } catch (e) {
    // A folder's own failure never aborts the rest of the batch (§3.6/§3.8):
    // this row's status is left as a visible trace, other folders proceed.
    await patchMaterial(scope, materialId, { status: "error", status_detail: errorCodeOf(e), progress: {} });
    return { slug: folder.slug, outcome: "error", errorDetail: e instanceof Error ? e.message : "failed" };
  }

  // Same "positive signal" as the AI path (ADR-023 §Частина 3 / D-103):
  // the parent importing real content for a subject is itself the trigger to
  // start warming the lesson library — best-effort, never blocks the commit.
  const { data: firstTopic } = await scope.select("topics", "id").eq("material_id", materialId).order("sort_order").limit(1).maybeSingle<{ id: string }>();
  if (firstTopic) {
    await warmAheadForSubject(familyId, subjectId, { anchorTopicId: firstTopic.id }).catch((e: Error) =>
      console.error(`warm-ahead after manual batch import failed: ${e.message}`),
    );
  }

  return {
    slug: folder.slug,
    outcome: "imported",
    topicsImported: folderPlan.importableCount,
    needsReviewCount: folderPlan.qrCount + folderPlan.unknownStatusCount,
    imageOnlyCount: folderPlan.imageOnlyCount,
  };
}

async function runManualBatchCommit(job: JobRow, ctx: { deadline: number }): Promise<void | { requeue: true }> {
  const familyId = job.family_id;
  const batchId = String(job.payload.batchId);
  const decisions = (job.payload.decisions ?? {}) as Record<string, FolderDecision>;
  const scope = forFamily(familyId);
  const batch = await loadBatch(scope, batchId);
  if (!batch || batch.status === "done") return;

  let parsed;
  try {
    parsed = await downloadAndParse(batch.drive_file_id);
  } catch (e) {
    await patchBatch(scope, batchId, { status: "error", error_detail: errorCodeOf(e) });
    return;
  }
  if (parsed.form !== "batch") {
    await patchBatch(scope, batchId, { status: "error", error_detail: "reparse_mismatch" });
    return;
  }

  if (batch.status !== "importing") await patchBatch(scope, batchId, { status: "importing" });

  const { data: year } = await scope.select("academic_years", "grade").eq("status", "active").maybeSingle<{ grade: number }>();

  const report: FolderCommitResult[] = [];
  for (const folder of parsed.folders) {
    if (Date.now() > ctx.deadline - 30_000) return { requeue: true };
    const decision = decisions[folder.slug] ?? { action: "skip" as const };
    report.push(await commitFolder(scope, familyId, batch, folder, decision, year?.grade ?? null));
  }

  await patchBatch(scope, batchId, { status: "done", plan: { form: "batch", folders: parsed.folders.map(buildFolderPlan), report }, error_detail: null });
}

let registered = false;
export function registerManualBatchJobs(): void {
  if (registered) return;
  registered = true;
  const common = { isRetryable: isRetryableIngestError };
  registerJobHandler(MANUAL_BATCH_JOB.preview, {
    ...common,
    run: runManualBatchPreview,
    onGiveUp: async (job: JobRow, e: unknown) => {
      const batchId = job.payload.batchId;
      if (typeof batchId !== "string") return;
      await patchBatch(forFamily(job.family_id), batchId, { status: "error", error_detail: errorCodeOf(e) });
    },
  });
  registerJobHandler(MANUAL_BATCH_JOB.commit, {
    ...common,
    run: runManualBatchCommit,
    onGiveUp: async (job: JobRow, e: unknown) => {
      const batchId = job.payload.batchId;
      if (typeof batchId !== "string") return;
      await patchBatch(forFamily(job.family_id), batchId, { status: "error", error_detail: errorCodeOf(e) });
    },
  });
}

/** Enqueues "Розібрати архів" (idempotent — dedupeKey). */
export async function startManualBatchPreview(familyId: string, batchId: string): Promise<void> {
  await enqueueJob(familyId, MANUAL_BATCH_JOB.preview, { batchId }, { dedupeKey: `${MANUAL_BATCH_JOB.preview}:${batchId}` });
}

/** Enqueues "Імпортувати" with the parent's per-folder decisions (ADR-031 §3.8). */
export async function startManualBatchCommit(familyId: string, batchId: string, decisions: Record<string, FolderDecision>): Promise<void> {
  await enqueueJob(familyId, MANUAL_BATCH_JOB.commit, { batchId, decisions }, { dedupeKey: `${MANUAL_BATCH_JOB.commit}:${batchId}` });
}
