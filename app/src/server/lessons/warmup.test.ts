import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-023 (D-76/D-77): `ensureActiveLibraryBlock` is the one function shared
 * by the "cold" child-open path and the `is_current` warm-up signal — these
 * tests cover its branches (already warm / joins an existing job / enqueues
 * a new one / the daily warm-up budget defers a new one) with a small
 * scriptable fake for the two DB entry points it uses (`forFamily`'s
 * `.count()` and the service-role `jobs` table), same style as
 * `friendChat.test.ts`.
 */

let activeCount = 0;
const countScope = {
  count: () => {
    const self = { eq: () => self, then: (res: (v: unknown) => unknown) => Promise.resolve({ count: activeCount }).then(res) };
    return self;
  },
};
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => countScope }));

interface JobRow {
  id: string;
  status: string;
}
let existingJob: JobRow | null = null;
let insertedJobs: Record<string, unknown>[] = [];
let insertError: { code: string; message: string } | null = null;
let warmSpendUsd = 0;
let updatedJobs: { id: string; values: Record<string, unknown> }[] = [];

const jobsTable = {
  select: () => ({
    eq: () => ({
      eq: () => ({
        in: () => ({
          maybeSingle: () => Promise.resolve({ data: existingJob }),
        }),
      }),
    }),
  }),
  insert: (row: Record<string, unknown>) => ({
    select: () => ({
      single: () => {
        if (insertError) return Promise.resolve({ data: null, error: insertError });
        insertedJobs.push(row);
        return Promise.resolve({ data: { id: "job-new" }, error: null });
      },
    }),
  }),
  update: (values: Record<string, unknown>) => ({
    eq: (col: string, id: string) => ({
      eq: () => {
        updatedJobs.push({ id, values });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  }),
};

const kickJobs = vi.fn();
vi.mock("@/server/jobs/kick", () => ({ kickJobs: (...a: unknown[]) => kickJobs(...a) }));
vi.mock("@/server/jobs/runner", () => ({ registerJobHandler: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({
  createServiceClient: () => ({
    from: (table: string) => (table === "jobs" ? jobsTable : { select: () => ({}) }),
    rpc: (name: string) => (name === "get_library_warm_daily_spend" ? Promise.resolve({ data: warmSpendUsd, error: null }) : Promise.resolve({ data: null, error: null })),
  }),
}));

const { ensureActiveLibraryBlock, warmDedupeKey } = await import("./warmup");

const subject = { id: "subj1", nameUk: "Математика", config: {} };
const topic = { id: "top1", title: "Дроби", grade: 6 };

beforeEach(() => {
  activeCount = 0;
  existingJob = null;
  insertedJobs = [];
  insertError = null;
  warmSpendUsd = 0;
  updatedJobs = [];
  kickJobs.mockClear();
});

describe("ensureActiveLibraryBlock (ADR-023)", () => {
  it("reports 'active' and enqueues nothing when the topic already has an active block", async () => {
    activeCount = 1;
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: true });
    expect(result).toEqual({ status: "active" });
    expect(insertedJobs).toHaveLength(0);
    expect(kickJobs).not.toHaveBeenCalled();
  });

  it("joins an already-pending/running job instead of enqueueing a duplicate (dedupe_key)", async () => {
    existingJob = { id: "job-existing", status: "running" };
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: true });
    expect(result).toEqual({ status: "job_running", jobId: "job-existing" });
    expect(insertedJobs).toHaveLength(0);
    // "cold" (immediate) path still kicks the runner even when joining.
    expect(kickJobs).toHaveBeenCalledTimes(1);
  });

  it("enqueues a new library.warm_topic job with the topic's dedupe key when the topic is cold", async () => {
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: true });
    expect(result.status).toBe("job_pending");
    expect(insertedJobs).toHaveLength(1);
    expect(insertedJobs[0]).toMatchObject({ type: "library.warm_topic", dedupe_key: warmDedupeKey("top1"), family_id: "fam1" });
    expect(kickJobs).toHaveBeenCalledTimes(1);
  });

  it("does NOT kick the runner for the non-blocking is_current signal (immediate: false)", async () => {
    await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: false });
    expect(insertedJobs).toHaveLength(1);
    expect(kickJobs).not.toHaveBeenCalled();
  });

  it("defers (no new job) once the daily warm-up budget (ADR-023 §1.6) is already spent", async () => {
    warmSpendUsd = 5; // >= the $5/day default (LIBRARY_WARM_DAILY_BUDGET_USD)
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: true });
    expect(result).toEqual({ status: "deferred_daily_budget" });
    expect(insertedJobs).toHaveLength(0);
    expect(kickJobs).not.toHaveBeenCalled();
  });

  it("still enqueues when spend is below the daily budget", async () => {
    warmSpendUsd = 4.99;
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: true });
    expect(result.status).toBe("job_pending");
  });
});
