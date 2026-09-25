import "server-only";
import { createServiceClient } from "../supabase/clients";

/**
 * Background jobs (ADR-015): a `jobs` table, claimed with SKIP LOCKED, run in
 * small steps within one function invocation (≤ 300 s on Vercel). Triggered
 * by `after()` from parent actions, by `/api/jobs/tick` (Vercel cron / pg_cron)
 * and by the "Мої книги" page while indexing is in progress.
 */
export interface JobRow {
  id: string;
  family_id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobOutcome = void | { requeue: true };

export interface JobHandler {
  run(job: JobRow, ctx: { deadline: number }): Promise<JobOutcome>;
  /** Called once when the job is given up (non-retryable or out of attempts). */
  onGiveUp?(job: JobRow, error: unknown): Promise<void>;
  /** Decides whether an error is worth another attempt later. */
  isRetryable?(error: unknown): boolean;
}

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export async function enqueueJob(
  familyId: string,
  type: string,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; runAfter?: Date } = {},
): Promise<void> {
  const { error } = await createServiceClient()
    .from("jobs")
    .insert({
      family_id: familyId,
      type,
      payload,
      dedupe_key: opts.dedupeKey ?? null,
      run_after: (opts.runAfter ?? new Date()).toISOString(),
    });
  // 23505: the same job is already pending — enqueue is idempotent (NFR-RES-3).
  if (error && error.code !== "23505") throw new Error(`enqueueJob failed: ${error.message}`);
}

/** Exponential backoff: 30 s, 60 s, 120 s … capped at 30 min. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 1800);
}

export async function runJobs(opts: { budgetMs?: number; maxJobs?: number } = {}): Promise<{ processed: number }> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 240_000);
  const db = createServiceClient();
  let processed = 0;
  while (Date.now() < deadline - 15_000 && processed < (opts.maxJobs ?? 200)) {
    const { data, error } = await db.rpc("claim_jobs", { p_limit: 1, p_lock_seconds: 300 });
    if (error) throw new Error(`claim_jobs failed: ${error.message}`);
    const job = (data as JobRow[] | null)?.[0];
    if (!job) break;
    processed += 1;
    const handler = handlers.get(job.type);
    if (!handler) {
      await db.from("jobs").update({ status: "failed", last_error: "no handler", locked_until: null }).eq("id", job.id);
      continue;
    }
    try {
      const outcome = await handler.run(job, { deadline });
      if (outcome && "requeue" in outcome) {
        await db
          .from("jobs")
          .update({ status: "queued", attempts: Math.max(0, job.attempts - 1), run_after: new Date().toISOString(), locked_until: null })
          .eq("id", job.id);
      } else {
        await db.from("jobs").update({ status: "done", locked_until: null, last_error: null }).eq("id", job.id);
      }
    } catch (e) {
      const message = (e as Error)?.message?.slice(0, 500) ?? "error";
      const retryable = handler.isRetryable ? handler.isRetryable(e) : true;
      if (retryable && job.attempts < job.max_attempts) {
        await db
          .from("jobs")
          .update({
            status: "queued",
            last_error: message,
            locked_until: null,
            run_after: new Date(Date.now() + backoffSeconds(job.attempts) * 1000).toISOString(),
          })
          .eq("id", job.id);
      } else {
        await db.from("jobs").update({ status: "failed", last_error: message, locked_until: null }).eq("id", job.id);
        await handler.onGiveUp?.(job, e).catch((err: Error) => console.error(`onGiveUp failed: ${err.message}`));
      }
    }
  }
  return { processed };
}
