import "server-only";
import { getBudget } from "@/server/ai/store";
import { forFamily } from "@/server/db/family-scope";
import { getLibraryWarmDailyBudgetUsd, getLibraryWarmLookaheadTopics, getLibraryWarmMaxConcurrent } from "@/server/env";
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

/**
 * US-22.4 (D-108, S33): tags a `library.warm_topic` job by where it came
 * from — the existing automatic triggers (`is_current`, ADR-023 §Частина 1/3)
 * vs. the parent's own explicit, already-cost-confirmed bulk launch — purely
 * for reporting/де-дуплікація status (КП-5/КП-6); `registerLibraryWarmJobs`
 * behaves identically regardless of `source`.
 */
export type WarmJobSource = "auto" | "manual_bulk";

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
  /** BUG-035: current generate→review pass (1-based), when `stage` is
   * "generating"/"revising"/"reviewing"; `null`/absent otherwise. */
  reviewPass?: number | null;
  /** US-22.4 (D-108): `"manual_bulk"` for this slice's bulk launch, `"auto"` for
   * every existing trigger (`is_current`, `warmAheadForSubject`). */
  source: WarmJobSource;
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
  opts: {
    immediate: boolean;
    /** US-22.4 (D-108): defaults to `"auto"` — pass `"manual_bulk"` only from
     * the confirmed bulk-launch action. */
    source?: WarmJobSource;
    /**
     * US-22.4 §КП-3 (D-108, 12.28): the manual bulk launch's own cost-confirmation
     * screen (КП-2) IS the spending safeguard for THIS path — a second, silent
     * daily-cap check right after the parent already confirmed the exact
     * amount adds no safety and only breaks the "все за ніч" promise into a
     * silent partial run. `true` skips §Частина 1.6's daily soft cap
     * (`LIBRARY_WARM_DAILY_BUDGET_USD`) for this one call; the monthly
     * 80/100/110% budget states (ADR-012) still apply unchanged to every
     * individual `callModel` call regardless of this flag — this only ever
     * touches the DAILY soft cap, never the hard monthly thresholds.
     */
    bypassDailyBudget?: boolean;
  },
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
  // US-22.4 (D-108, 12.28): explicitly skipped for the manual bulk launch —
  // its own cost-confirmation screen already IS the safeguard for that path.
  if (!opts.bypassDailyBudget) {
    const spentToday = await warmSpendTodayUsd(familyId);
    if (spentToday >= getLibraryWarmDailyBudgetUsd()) {
      return { status: "deferred_daily_budget" };
    }
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
    source: opts.source ?? "auto",
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

interface WarmAheadSubjectRow {
  id: string;
  name_uk: string;
  config: Record<string, unknown>;
  active: boolean;
  is_stub: boolean;
}
interface WarmAheadTopicRow {
  id: string;
  title: string;
  grade: number | null;
  sort_order: number;
}

/**
 * "Прогрів наперед" (ADR-023 §Частина 3, D-103): the parent's action (a
 * freshly-indexed textbook's topics, activating a subject, or the child
 * opening the next topic in sequence) is itself a strong enough signal that
 * a subject's material is about to be studied — no separate manual
 * "positive" `is_current` click should be required per topic for the server
 * to start getting ready.
 *
 * Finds the **anchor** — `opts.anchorTopicId` when the caller already knows
 * which topic to start from (§Частина 3.3 — `startLessonSession` anchors on
 * the topic the child just opened, not necessarily the subject's
 * `is_current` one); otherwise the subject's `is_current` topic if it has
 * one; otherwise the first topic by `sort_order` (a subject with no
 * `is_current` topic yet, e.g. right after indexing its first textbook,
 * §Частина 3.1/3.2) — then warms up to `LIBRARY_WARM_LOOKAHEAD_TOPICS`
 * topics (default 3) starting at the anchor (inclusive), in `sort_order`,
 * one at a time (not `Promise.all` — `ensureActiveLibraryBlock`'s own
 * dedup/daily-budget checks are per-call, so doing this sequentially keeps
 * their behaviour meaningful call to call).
 *
 * Never throws — a per-topic failure (e.g. the daily warm-up budget runs out
 * partway through the lookahead window) is logged and does not stop the rest
 * of the loop or bubble up to whichever trigger called this (same
 * fire-and-forget pattern already used by `setCurrentTopicAction`).
 */
export async function warmAheadForSubject(familyId: string, subjectId: string, opts: { anchorTopicId?: string } = {}): Promise<void> {
  const scope = forFamily(familyId);
  const { data: subject } = await scope
    .select("subjects", "id, name_uk, config, active, is_stub")
    .eq("id", subjectId)
    .maybeSingle<WarmAheadSubjectRow>();
  // §Частина 3.1: only for a subject that is active and not a stub — a stub
  // subject (US-3.4) never calls AI, and an inactive one has no lessons to
  // get ready for yet.
  if (!subject || !subject.active || subject.is_stub) return;

  let anchorSortOrder: number | null = null;
  if (opts.anchorTopicId) {
    const { data: anchorTopic } = await scope
      .select("topics", "sort_order")
      .eq("id", opts.anchorTopicId)
      .maybeSingle<{ sort_order: number }>();
    anchorSortOrder = anchorTopic?.sort_order ?? null;
  }
  if (anchorSortOrder === null) {
    const { data: currentTopic } = await scope
      .select("topics", "sort_order")
      .eq("subject_id", subjectId)
      .eq("is_current", true)
      .maybeSingle<{ sort_order: number }>();
    anchorSortOrder = currentTopic?.sort_order ?? null;
  }

  let query = scope
    .select("topics", "id, title, grade, sort_order")
    .eq("subject_id", subjectId)
    .order("sort_order", { ascending: true })
    .limit(getLibraryWarmLookaheadTopics());
  if (anchorSortOrder !== null) query = query.gte("sort_order", anchorSortOrder);
  const { data: topics } = await query.returns<WarmAheadTopicRow[]>();

  for (const topic of topics ?? []) {
    try {
      await ensureActiveLibraryBlock(
        familyId,
        { id: subject.id, nameUk: subject.name_uk, config: subject.config },
        { id: topic.id, title: topic.title, grade: topic.grade },
        { immediate: false },
      );
    } catch (e) {
      console.error(`warmAheadForSubject: ensureActiveLibraryBlock failed for topic ${topic.id}: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// US-22.4 (D-108, S33): the parent's own manual, potentially large bulk
// launch ("Підготувати уроки" on the subject's topic list) — a SEPARATE
// entry point from `warmAheadForSubject` above (a different trigger, a
// different budget rule), sharing only `ensureActiveLibraryBlock` and the
// same `library.warm_topic` queue (docs/05 S33: "жодного нового конвеєра
// генерації").
// ---------------------------------------------------------------------------

/** ADR-023 §Частина 1.2 tariff for one topic's warm-up (one library block). */
export const WARM_TOPIC_COST_USD = 0.33;

/** US-22.4 КП-4: an extra "усвідомленість" line above this amount, `*(налашт.)*`. */
export const BULK_WARM_AWARENESS_THRESHOLD_USD = 10;

export type TopicWarmStatus = "ready" | "queued" | "generating" | "error";

/**
 * US-22.4 КП-5 (status badges) / КП-6 (де-дуплікація): the CURRENT status of
 * each requested topic, derived purely from data already in `library_items`/
 * `jobs` — the very same de-dup facts `ensureActiveLibraryBlock` itself
 * checks, so this reads consistently whether a topic's job came from this
 * slice's manual bulk launch or any of ADR-023's automatic triggers. A topic
 * with neither an active block nor any `library.warm_topic` job is left out
 * of the returned record entirely (no badge — "not touched yet", КП-1).
 */
export async function getTopicWarmupStatuses(familyId: string, topicIds: string[]): Promise<Record<string, TopicWarmStatus>> {
  const uniqueIds = Array.from(new Set(topicIds));
  const result: Record<string, TopicWarmStatus> = {};
  if (uniqueIds.length === 0) return result;

  const scope = forFamily(familyId);
  const [{ data: activeItems }, { data: jobs }] = await Promise.all([
    scope
      .select("library_items", "topic_id")
      .eq("kind", "block")
      .eq("status", "active")
      .in("topic_id", uniqueIds)
      .returns<{ topic_id: string }[]>(),
    scope
      .select("jobs", "dedupe_key, status, created_at")
      .eq("type", LIBRARY_WARM_JOB_TYPE)
      .in("dedupe_key", uniqueIds.map(warmDedupeKey))
      .order("created_at", { ascending: false })
      .returns<{ dedupe_key: string; status: string; created_at: string }[]>(),
  ]);

  const activeSet = new Set((activeItems ?? []).map((r) => r.topic_id));
  // Most-recent-first order above, so the first row seen per dedupe_key is
  // that topic's latest job — a topic can have an older `failed` row and a
  // newer `queued` retry sharing the same dedupe_key (§Частина 1.3/1.7: the
  // unique index only blocks a duplicate while `queued`/`running`).
  const latestJobStatusByDedupe = new Map<string, string>();
  for (const j of jobs ?? []) if (!latestJobStatusByDedupe.has(j.dedupe_key)) latestJobStatusByDedupe.set(j.dedupe_key, j.status);

  for (const topicId of uniqueIds) {
    if (activeSet.has(topicId)) {
      result[topicId] = "ready";
      continue;
    }
    const jobStatus = latestJobStatusByDedupe.get(warmDedupeKey(topicId));
    if (jobStatus === "queued") result[topicId] = "queued";
    else if (jobStatus === "running") result[topicId] = "generating";
    else if (jobStatus === "failed") result[topicId] = "error";
    // "done" without an active block would be a data inconsistency (a
    // finished warm job always leaves an active block behind) — never
    // observed, so left untouched (no badge) rather than guessed at.
  }
  return result;
}

export interface BulkWarmTopicEstimate {
  topicId: string;
  /** `false` — already `active` or already `queued`/`running` (КП-6: $0, shown transparently, never hidden/disabled). */
  needsPrep: boolean;
}

export interface BulkWarmEstimate {
  items: BulkWarmTopicEstimate[];
  selectedCount: number;
  /** Already active/queued/running — excluded from the cost (КП-2/КП-6). */
  readyCount: number;
  neededCount: number;
  estimatedCostUsd: number;
  monthlySpentUsd: number;
  monthlyLimitUsd: number;
  /** КП-4: an extra "усвідомленість" line for a large batch. */
  exceedsAwarenessThreshold: boolean;
  /**
   * КП-3: `spentUsd + estimatedCostUsd >= limitUsd` — the confirm button
   * must be replaced entirely (no silent partial launch), unlike the daily
   * soft cap this slice otherwise bypasses. The hard monthly 100%/110%
   * thresholds (ADR-012) apply here with NO exceptions.
   */
  wouldExceedMonthlyLimit: boolean;
}

/**
 * US-22.4 КП-2 (D-108): the exact pre-confirmation cost estimate — which of
 * the selected topics genuinely need a new `library.warm_topic` job (КП-6
 * de-dup, reusing the same facts `ensureActiveLibraryBlock` checks) and the
 * resulting ≈$0.33/topic total, checked against the family's CURRENT monthly
 * budget (ADR-012) so the confirm screen can replace its own button with the
 * "ліміт вичерпано" state (КП-3) before anything is ever enqueued.
 */
export async function estimateBulkWarmup(familyId: string, topicIds: string[]): Promise<BulkWarmEstimate> {
  const uniqueIds = Array.from(new Set(topicIds));
  const [statuses, budget] = await Promise.all([getTopicWarmupStatuses(familyId, uniqueIds), getBudget(familyId)]);

  const items: BulkWarmTopicEstimate[] = uniqueIds.map((topicId) => {
    const status = statuses[topicId];
    const needsPrep = status !== "ready" && status !== "queued" && status !== "generating";
    return { topicId, needsPrep };
  });
  const neededCount = items.filter((i) => i.needsPrep).length;
  const readyCount = items.length - neededCount;
  const estimatedCostUsd = Math.round(neededCount * WARM_TOPIC_COST_USD * 100) / 100;

  return {
    items,
    selectedCount: items.length,
    readyCount,
    neededCount,
    estimatedCostUsd,
    monthlySpentUsd: budget.spentUsd,
    monthlyLimitUsd: budget.limitUsd,
    exceedsAwarenessThreshold: estimatedCostUsd > BULK_WARM_AWARENESS_THRESHOLD_USD,
    wouldExceedMonthlyLimit: budget.limitUsd > 0 && budget.spentUsd + estimatedCostUsd >= budget.limitUsd,
  };
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

      // ADR-023 §Частина 3 (D-103): re-check `subjects.active`/`is_stub`
      // right before actually spending money, not just at enqueue time — a
      // job created by one of the new "за фактом дії дорослого" triggers can
      // sit queued for a while (concurrency cap, daily budget), and the
      // parent may deactivate the subject (or it may turn out to be a stub)
      // in the meantime. A small, cheap extra select, same pattern as the
      // "already active" check just above.
      const { data: subjectNow } = await scope
        .select("subjects", "active, is_stub")
        .eq("id", payload.subjectId)
        .maybeSingle<{ active: boolean; is_stub: boolean }>();
      if (!subjectNow || !subjectNow.active || subjectNow.is_stub) return;

      // BUG-035: also persists which generate→review pass is current, so
      // the child's progress screen can show "Перевірка 2 з 3" instead of
      // just repeating "Перевіряємо якість" and looking like it looped.
      const setStage = async (stage: PipelineStage, reviewPass?: number) => {
        await db.from("jobs").update({ payload: { ...job.payload, stage, reviewPass: reviewPass ?? null } }).eq("id", job.id);
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
