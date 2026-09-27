import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { getLibraryWarmDailyBudgetUsd, getLibraryWarmMaxConcurrent } from "@/server/env";
import { registerJobHandler, type JobRow } from "@/server/jobs/runner";
import { kickJobs } from "@/server/jobs/kick";
import { createServiceClient } from "@/server/supabase/clients";
import { generateOneBlock, loadCandidates } from "./generate";
import { ReviewerUnavailableError, type PipelineStage } from "./pipeline";

/**
 * Background library warm-up (ADR-023, D-76/D-77, D-89 — PO accepted the
 * architect's defaults for every open question): `ensureActiveLibraryBlock`
 * is the **one** function that guarantees a topic has at least one
 * `active` `library_items` block, shared by:
 *  - the parent marking topic(s) `is_current = true` (`setCurrentTopicAction`,
 *    §Частина 1.1 — can wait a few seconds, not blocking the parent's request);
 *  - the child opening a topic that never warmed up in time
 *    (`getOrGenerateLessonBlocks`'s "cold" branch — needs `run_after = now()`
 *    and an immediate `kickJobs()` in the same request, §Частина 1.2/1.7).
 *
 * Only the topic's **first** block is warmed (§Частина 1.2) — later blocks of
 * the same session are still generated progressively as today
 * (`nextSessionBlock`, unchanged, out of this ADR's scope).
 */

export const LIBRARY_WARM_JOB_TYPE = "library.warm_topic";

export function warmDedupeKey(topicId: string): string {
  return `library.warm:${topicId}`;
}

export interface WarmSubjectMeta {
  id: string;
  nameUk: string;
  config: Record<string, unknown>;
}
export interface WarmTopicMeta {
  id: string;
  title: string;
  grade: number | null;
}

export type EnsureActiveLibraryBlockResult =
  | { status: "active" }
  | { status: "job_pending" | "job_running"; jobId: string }
  /** ADR-023 §Частина 1.6: the daily warm-up budget is spent — no new job started. */
  | { status: "deferred_daily_budget" };

interface WarmJobPayload {
  topicId: string;
  subjectId: string;
  subjectNameUk: string;
  subjectConfig: Record<string, unknown>;
  topicTitle: string;
  grade: number | null;
  /** Module is fixed to "school" for every MVP subject today (docs/02 §14.1). */
  moduleCode: "school";
  stage: PipelineStage;
}

/**
 * ADR-023 §Частина 1.6: today's total cost of calls tagged with a
 * `library.warm_topic` job (`ai_calls.job_id is not null`), in the family's
 * own timezone. Fails **open** (returns 0, logging the error) — this is a
 * soft, best-effort guard (docs/02 6.2 already enforces the hard monthly
 * 80/100/110% thresholds on every individual call regardless).
 */
export async function warmSpendTodayUsd(familyId: string): Promise<number> {
  const { data, error } = await createServiceClient().rpc("get_library_warm_daily_spend", { p_family_id: familyId });
  if (error) {
    console.error(`get_library_warm_daily_spend failed: ${error.message}`);
    return 0;
  }
  return Number(data ?? 0);
}

/**
 * Ensures a topic has (or will soon have) at least one `active` block.
 * Never runs the pipeline itself — only enqueues/joins a `library.warm_topic`
 * job; `opts.immediate` controls whether it also nudges `run_after` to now
 * and calls `kickJobs()` in this same request (the "cold" case) or simply
 * lets the normal `pg_cron` tick pick it up within a minute (the `is_current`
 * signal — "може почекати кілька секунд, не блокуюче").
 */
export async function ensureActiveLibraryBlock(
  familyId: string,
  subject: WarmSubjectMeta,
  topic: WarmTopicMeta,
  opts: { immediate: boolean },
): Promise<EnsureActiveLibraryBlockResult> {
  const scope = forFamily(familyId);
  const { count: activeCount } = await scope
    .count("library_items")
    .eq("topic_id", topic.id)
    .eq("kind", "block")
    .eq("status", "active");
  if ((activeCount ?? 0) > 0) return { status: "active" };

  const db = createServiceClient();
  const dedupeKey = warmDedupeKey(topic.id);

  const { data: existing } = await db
    .from("jobs")
    .select("id, status")
    .eq("family_id", familyId)
    .eq("dedupe_key", dedupeKey)
    .in("status", ["queued", "running"])
    .maybeSingle<{ id: string; status: string }>();
  if (existing) {
    if (opts.immediate) {
      await db.from("jobs").update({ run_after: new Date().toISOString() }).eq("id", existing.id).eq("status", "queued");
      kickJobs();
    }
    return { status: existing.status === "running" ? "job_running" : "job_pending", jobId: existing.id };
  }

  // §Частина 1.6: a soft daily cap on warm-up spend specifically — a
  // safeguard for the parent marking many topics `is_current` in one sitting
  // (docs/01 D-65), independent of the monthly budget states (ADR-012).
  const spentToday = await warmSpendTodayUsd(familyId);
  if (spentToday >= getLibraryWarmDailyBudgetUsd()) {
    return { status: "deferred_daily_budget" };
  }

  const payload: WarmJobPayload = {
    topicId: topic.id,
    subjectId: subject.id,
    subjectNameUk: subject.nameUk,
    subjectConfig: subject.config,
    topicTitle: topic.title,
    grade: topic.grade,
    moduleCode: "school",
    stage: "planning",
  };
  const { data: inserted, error: insertError } = await db
    .from("jobs")
    .insert({
      family_id: familyId,
      type: LIBRARY_WARM_JOB_TYPE,
      payload,
      dedupe_key: dedupeKey,
      run_after: new Date().toISOString(),
      // BUG-032: 30 violated `jobs`'s own `max_attempts between 1 and 20`
      // check constraint (S1, 20260926100000) on every insert, so every
      // warm-up attempt failed outright and surfaced to the parent as the
      // generic "check AI settings" error — 20 is the schema's own ceiling,
      // still generous next to the default 5.
      max_attempts: 20,
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError) {
    if (insertError.code === "23505") {
      // Lost a race with another request enqueuing the same dedupe key.
      const { data: racedJob } = await db
        .from("jobs")
        .select("id, status")
        .eq("family_id", familyId)
        .eq("dedupe_key", dedupeKey)
        .in("status", ["queued", "running"])
        .maybeSingle<{ id: string; status: string }>();
      if (opts.immediate) kickJobs();
      return racedJob ? { status: racedJob.status === "running" ? "job_running" : "job_pending", jobId: racedJob.id } : { status: "job_pending", jobId: "" };
    }
    throw new Error(`enqueueing ${LIBRARY_WARM_JOB_TYPE} failed: ${insertError.message}`);
  }

  if (opts.immediate) kickJobs();
  return { status: "job_pending", jobId: inserted.id };
}

/**
 * Registers the `library.warm_topic` job handler. Called from
 * `ensureJobHandlers()` (`jobs/kick.ts`), same composition-root pattern as
 * every other job family (ingest, notify).
 */
export function registerLibraryWarmJobs(): void {
  registerJobHandler(LIBRARY_WARM_JOB_TYPE, {
    async run(job: JobRow) {
      const db = createServiceClient();
      const payload = job.payload as unknown as WarmJobPayload;

      // §Частина 1.5: global concurrency cap across every concurrent
      // invocation (`claim_jobs` already marked this job `running` before we
      // get here, so counting *other* running warm jobs and comparing
      // against the max tells us whether allowing this one to proceed too
      // would exceed it). A short, cheap re-queue — never burns a provider
      // call — instead of an error that would consume one of the job's
      // retry attempts.
      const { count: otherRunning } = await db
        .from("jobs")
        .select("*", { count: "exact", head: true })
        .eq("type", LIBRARY_WARM_JOB_TYPE)
        .eq("status", "running")
        .neq("id", job.id);
      if ((otherRunning ?? 0) >= getLibraryWarmMaxConcurrent()) {
        return { requeue: true, delaySeconds: 5 };
      }

      // A sibling attempt (or the cold path's own `ensureActiveLibraryBlock`
      // call, which can join this very job) may have already produced an
      // active block for this topic — nothing left to do, spend nothing more.
      const scope = forFamily(job.family_id);
      const already = await loadCandidates(scope, payload.topicId, 1);
      if (already.length > 0) return;

      const setStage = async (stage: PipelineStage) => {
        await db.from("jobs").update({ payload: { ...job.payload, stage } }).eq("id", job.id);
      };

      try {
        await generateOneBlock(
          scope,
          job.family_id,
          payload.subjectId,
          payload.subjectNameUk,
          payload.subjectConfig,
          payload.topicId,
          payload.topicTitle,
          payload.grade,
          { jobId: job.id, onStage: setStage },
        );
      } catch (e) {
        // BUG-011-style: an unconfigured reviewer will never succeed on
        // retry either — give up right away instead of burning through 30
        // attempts' worth of backoff. The cold path's own fallback template
        // (`getOrCreateFallbackBlock`, via `checkWarmupProgress`) still
        // covers the child regardless of why this job never finished.
        if (e instanceof ReviewerUnavailableError) throw Object.assign(e, { __warmupGiveUp: true });
        throw e;
      }
    },
    isRetryable: (error: unknown) => !(error as { __warmupGiveUp?: boolean } | undefined)?.__warmupGiveUp,
    async onGiveUp(job: JobRow, error: unknown) {
      const topicId = (job.payload as { topicId?: string }).topicId ?? "?";
      console.error(`${LIBRARY_WARM_JOB_TYPE} gave up for topic ${topicId}: ${(error as Error)?.message ?? "error"}`);
    },
  });
}
