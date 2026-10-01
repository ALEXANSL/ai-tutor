import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * A small, generic fake `select(table, cols).eq(...).gte(...).order(...).limit(...).maybeSingle()/.returns()`
 * builder for `warmAheadForSubject` (ADR-023 §Частина 3) — filters are
 * applied first, then ordering, then the limit, same precedence as the real
 * Postgrest query regardless of the order the chain methods were called in
 * (the actual code calls `.gte()` *after* `.limit()` when there's an anchor).
 */
type Row = Record<string, unknown>;
function makeSelectBuilder(rows: Row[]) {
  const filters: ((r: Row) => boolean)[] = [];
  let orderCol: string | null = null;
  let orderAsc = true;
  let limitN: number | null = null;
  const run = () => {
    let list = rows.filter((r) => filters.every((f) => f(r)));
    if (orderCol) {
      const col = orderCol;
      list = [...list].sort((a, b) => (orderAsc ? Number(a[col]) - Number(b[col]) : Number(b[col]) - Number(a[col])));
    }
    if (limitN != null) list = list.slice(0, limitN);
    return list;
  };
  const builder = {
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      const set = new Set(vals);
      filters.push((r) => set.has(r[col]));
      return builder;
    },
    gte: (col: string, val: unknown) => {
      filters.push((r) => Number(r[col]) >= Number(val));
      return builder;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return builder;
    },
    limit: (n: number) => {
      limitN = n;
      return builder;
    },
    maybeSingle: () => Promise.resolve({ data: run()[0] ?? null }),
    returns: () => Promise.resolve({ data: run() }),
  };
  return builder;
}

let subjectsData: Row[] = [];
let topicsData: Row[] = [];
let libraryItemsData: Row[] = [];
let scopeJobsData: Row[] = [];

const scope = {
  count: () => {
    const self = { eq: () => self, then: (res: (v: unknown) => unknown) => Promise.resolve({ count: activeCount }).then(res) };
    return self;
  },
  select: (table: string) =>
    makeSelectBuilder(
      table === "subjects" ? subjectsData : table === "topics" ? topicsData : table === "library_items" ? libraryItemsData : table === "jobs" ? scopeJobsData : [],
    ),
};
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => scope }));

let budgetSpentUsd = 0;
let budgetLimitUsd = 100;
vi.mock("@/server/ai/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ai/store")>();
  return {
    ...actual,
    getBudget: () => Promise.resolve({ month: "2026-09", state: "normal", spentUsd: budgetSpentUsd, limitUsd: budgetLimitUsd }),
  };
});

interface JobRow {
  id: string;
  status: string;
}
let existingJob: JobRow | null = null;
let insertedJobs: Record<string, unknown>[] = [];
let insertError: { code: string; message: string } | null = null;
let warmSpendUsd = 0;
let updatedJobs: { id: string; values: Record<string, unknown> }[] = [];
/** `registerLibraryWarmJobs`'s concurrency-cap check (`otherRunning`, §1.5). */
let otherRunningCount = 0;

const jobsTable = {
  // Two different shapes reuse this same builder: the dedupe lookup
  // (`.eq().eq().in().maybeSingle()`) and the concurrency-cap count, which is
  // awaited directly on the chain without a terminal call
  // (`.eq().eq().neq()`, resolving to `{ count }`).
  select: () => {
    const self: Record<string, unknown> = {
      eq: () => self,
      neq: () => self,
      in: () => ({ maybeSingle: () => Promise.resolve({ data: existingJob }) }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ count: otherRunningCount }).then(res),
    };
    return self;
  },
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

const registerJobHandler = vi.fn();
vi.mock("@/server/jobs/runner", () => ({ registerJobHandler: (...a: unknown[]) => registerJobHandler(...a) }));

vi.mock("@/server/supabase/clients", () => ({
  createServiceClient: () => ({
    from: (table: string) => (table === "jobs" ? jobsTable : { select: () => ({}) }),
    rpc: (name: string) => (name === "get_library_warm_daily_spend" ? Promise.resolve({ data: warmSpendUsd, error: null }) : Promise.resolve({ data: null, error: null })),
  }),
}));

const generateOneBlockMock = vi.fn();
const loadCandidatesMock = vi.fn();
const { NoIndexedFragmentsError } = await import("./generate");
vi.mock("./generate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./generate")>();
  return {
    ...actual,
    generateOneBlock: (...a: unknown[]) => generateOneBlockMock(...a),
    loadCandidates: (...a: unknown[]) => loadCandidatesMock(...a),
  };
});

const { ensureActiveLibraryBlock, warmAheadForSubject, registerLibraryWarmJobs, warmDedupeKey, getTopicWarmupStatuses, estimateBulkWarmup, WARM_TOPIC_COST_USD } =
  await import("./warmup");

const subject = { id: "subj1", nameUk: "Математика", config: {} };
const topic = { id: "top1", title: "Дроби", grade: 6 };

beforeEach(() => {
  activeCount = 0;
  existingJob = null;
  insertedJobs = [];
  insertError = null;
  warmSpendUsd = 0;
  updatedJobs = [];
  otherRunningCount = 0;
  subjectsData = [];
  topicsData = [];
  libraryItemsData = [];
  scopeJobsData = [];
  budgetSpentUsd = 0;
  budgetLimitUsd = 100;
  kickJobs.mockClear();
  registerJobHandler.mockClear();
  generateOneBlockMock.mockClear();
  loadCandidatesMock.mockReset().mockResolvedValue([]);
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

  it("still kicks the runner for the non-blocking is_current signal (immediate: false) — 2026-10-01 incident: the only cron is once a day, kickJobs is cheap/safe to call always", async () => {
    await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: false });
    expect(insertedJobs).toHaveLength(1);
    expect(kickJobs).toHaveBeenCalledTimes(1);
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

/**
 * ADR-023 §Частина 3 (D-103): `warmAheadForSubject` — the new "за фактом дії
 * дорослого" trigger. Covers anchor selection (`is_current` topic / explicit
 * `anchorTopicId` / first by `sort_order` when neither is set), the
 * `LIBRARY_WARM_LOOKAHEAD_TOPICS` cap, and the active/stub guard.
 */
describe("warmAheadForSubject (ADR-023 §Частина 3, D-103)", () => {
  const ORIGINAL_LOOKAHEAD = process.env.LIBRARY_WARM_LOOKAHEAD_TOPICS;
  afterEach(() => {
    if (ORIGINAL_LOOKAHEAD === undefined) delete process.env.LIBRARY_WARM_LOOKAHEAD_TOPICS;
    else process.env.LIBRARY_WARM_LOOKAHEAD_TOPICS = ORIGINAL_LOOKAHEAD;
  });

  const topics = [
    { id: "t1", subject_id: "subj1", title: "Тема 1", grade: 6, sort_order: 1 },
    { id: "t2", subject_id: "subj1", title: "Тема 2", grade: 6, sort_order: 2 },
    { id: "t3", subject_id: "subj1", title: "Тема 3", grade: 6, sort_order: 3 },
    { id: "t4", subject_id: "subj1", title: "Тема 4", grade: 6, sort_order: 4 },
    { id: "t5", subject_id: "subj1", title: "Тема 5", grade: 6, sort_order: 5 },
  ];

  it("does nothing for a subject that is not active", async () => {
    subjectsData = [{ id: "subj1", name_uk: "Математика", config: {}, active: false, is_stub: false }];
    topicsData = [...topics];
    await warmAheadForSubject("fam1", "subj1");
    expect(insertedJobs).toHaveLength(0);
  });

  it("does nothing for a stub subject even if marked active", async () => {
    subjectsData = [{ id: "subj1", name_uk: "Малювання", config: {}, active: true, is_stub: true }];
    topicsData = [...topics];
    await warmAheadForSubject("fam1", "subj1");
    expect(insertedJobs).toHaveLength(0);
  });

  it("does nothing when the subject does not exist", async () => {
    subjectsData = [];
    topicsData = [...topics];
    await warmAheadForSubject("fam1", "subj-missing");
    expect(insertedJobs).toHaveLength(0);
  });

  it("anchors on the first topic by sort_order when the subject has no is_current topic (fresh textbook, §3.1/3.2)", async () => {
    subjectsData = [{ id: "subj1", name_uk: "Математика", config: {}, active: true, is_stub: false }];
    topicsData = topics.map((t) => ({ ...t, is_current: false }));
    await warmAheadForSubject("fam1", "subj1");
    // Default lookahead is 3: t1, t2, t3.
    expect(insertedJobs).toHaveLength(3);
    expect(insertedJobs.map((j) => (j as { dedupe_key: string }).dedupe_key)).toEqual([warmDedupeKey("t1"), warmDedupeKey("t2"), warmDedupeKey("t3")]);
  });

  it("anchors on the subject's is_current topic when it has one", async () => {
    subjectsData = [{ id: "subj1", name_uk: "Математика", config: {}, active: true, is_stub: false }];
    topicsData = topics.map((t) => ({ ...t, is_current: t.id === "t3" }));
    await warmAheadForSubject("fam1", "subj1");
    expect(insertedJobs.map((j) => (j as { dedupe_key: string }).dedupe_key)).toEqual([warmDedupeKey("t3"), warmDedupeKey("t4"), warmDedupeKey("t5")]);
  });

  it("anchors on opts.anchorTopicId when given, overriding is_current (§3.3 — startLessonSession opens topic X)", async () => {
    subjectsData = [{ id: "subj1", name_uk: "Математика", config: {}, active: true, is_stub: false }];
    topicsData = topics.map((t) => ({ ...t, is_current: t.id === "t1" }));
    await warmAheadForSubject("fam1", "subj1", { anchorTopicId: "t4" });
    expect(insertedJobs.map((j) => (j as { dedupe_key: string }).dedupe_key)).toEqual([warmDedupeKey("t4"), warmDedupeKey("t5")]);
  });

  it("respects a custom LIBRARY_WARM_LOOKAHEAD_TOPICS instead of the default 3", async () => {
    process.env.LIBRARY_WARM_LOOKAHEAD_TOPICS = "2";
    subjectsData = [{ id: "subj1", name_uk: "Математика", config: {}, active: true, is_stub: false }];
    topicsData = topics.map((t) => ({ ...t, is_current: false }));
    await warmAheadForSubject("fam1", "subj1");
    expect(insertedJobs).toHaveLength(2);
  });

  it("keeps going past a per-topic failure instead of stopping the loop (errors are logged, not thrown)", async () => {
    subjectsData = [{ id: "subj1", name_uk: "Математика", config: {}, active: true, is_stub: false }];
    topicsData = topics.map((t) => ({ ...t, is_current: false }));
    insertError = { code: "42P01", message: "boom" }; // a non-23505 insert failure on every call
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(warmAheadForSubject("fam1", "subj1")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * ADR-023 §Частина 3 (D-103): the `library.warm_topic` job handler must
 * re-check `subjects.active`/`is_stub` right before actually generating (not
 * just at enqueue time) — a job can sit queued long enough for the parent to
 * deactivate the subject in the meantime.
 */
describe("registerLibraryWarmJobs — re-checks subjects.active/is_stub before generating (ADR-023 §Частина 3)", () => {
  const job = {
    id: "job1",
    family_id: "fam1",
    payload: {
      topicId: "top1",
      subjectId: "subj1",
      subjectNameUk: "Математика",
      subjectConfig: {},
      topicTitle: "Дроби",
      grade: 6,
      moduleCode: "school",
      stage: "planning",
    },
  };

  function runHandler() {
    registerLibraryWarmJobs();
    const call = registerJobHandler.mock.calls.find((c) => c[0] === "library.warm_topic")!;
    return call[1] as { run: (job: unknown) => Promise<unknown> };
  }

  it("skips generation when the subject was deactivated after the job was enqueued", async () => {
    subjectsData = [{ id: "subj1", active: false, is_stub: false }];
    await runHandler().run(job);
    expect(generateOneBlockMock).not.toHaveBeenCalled();
  });

  it("skips generation when the subject turned out to be a stub", async () => {
    subjectsData = [{ id: "subj1", active: true, is_stub: true }];
    await runHandler().run(job);
    expect(generateOneBlockMock).not.toHaveBeenCalled();
  });

  it("skips generation when the subject no longer exists", async () => {
    subjectsData = [];
    await runHandler().run(job);
    expect(generateOneBlockMock).not.toHaveBeenCalled();
  });

  it("still generates when the subject is active and not a stub", async () => {
    subjectsData = [{ id: "subj1", active: true, is_stub: false }];
    generateOneBlockMock.mockResolvedValue(undefined);
    await runHandler().run(job);
    expect(generateOneBlockMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Prod incident 2026-09-28 (Bug 3): real jobs for topics with zero indexed
 * textbook fragments (confirmed mythology topics: "Лісовик", "Дажбог і
 * Жива", "Сокіл-Род", "Дерево Життя") kept retrying up to 20 times over many
 * hours — a condition that can NEVER succeed on retry, since retrying does
 * not create missing indexed content. `NoIndexedFragmentsError` must be
 * wired into the same `__warmupGiveUp` mechanism `ReviewerUnavailableError`
 * already uses (BUG-011-style), so the job fails fast instead.
 */
describe("registerLibraryWarmJobs — gives up immediately on a permanently unfixable failure (Bug 3, 2026-09-28)", () => {
  const job = {
    id: "job1",
    family_id: "fam1",
    payload: {
      topicId: "top1",
      subjectId: "subj1",
      subjectNameUk: "Українська міфологія",
      subjectConfig: {},
      topicTitle: "Лісовик",
      grade: 6,
      moduleCode: "school",
      stage: "planning",
    },
  };

  function runHandler() {
    registerLibraryWarmJobs();
    const call = registerJobHandler.mock.calls.find((c) => c[0] === "library.warm_topic")!;
    return call[1] as { run: (job: unknown) => Promise<unknown>; isRetryable: (error: unknown) => boolean };
  }

  it("tags NoIndexedFragmentsError with __warmupGiveUp instead of leaving it retryable", async () => {
    subjectsData = [{ id: "subj1", active: true, is_stub: false }];
    generateOneBlockMock.mockRejectedValue(new NoIndexedFragmentsError("top1"));
    const handler = runHandler();
    const error = await handler.run(job).catch((e) => e);
    expect(error).toBeInstanceOf(NoIndexedFragmentsError);
    expect((error as { __warmupGiveUp?: boolean }).__warmupGiveUp).toBe(true);
    expect(handler.isRetryable(error)).toBe(false);
  });

  it("keeps the exact message text startLessonAction matches on ('no indexed textbook fragments')", async () => {
    subjectsData = [{ id: "subj1", active: true, is_stub: false }];
    generateOneBlockMock.mockRejectedValue(new NoIndexedFragmentsError("top1"));
    const error = await runHandler().run(job).catch((e) => e);
    expect((error as Error).message).toContain("no indexed textbook fragments for topic top1");
  });

  it("still leaves an ordinary (transient) error retryable, unaffected by this fix", async () => {
    subjectsData = [{ id: "subj1", active: true, is_stub: false }];
    generateOneBlockMock.mockRejectedValue(new Error("temporary network blip"));
    const handler = runHandler();
    const error = await handler.run(job).catch((e) => e);
    expect(handler.isRetryable(error)).toBe(true);
  });
});

/**
 * US-22.4 (D-108, S33): `ensureActiveLibraryBlock`'s new `bypassDailyBudget`
 * opt-in and `source` tagging — the bulk manual launch's own already-confirmed
 * cost estimate replaces the daily soft cap for THAT path only; every other
 * caller (unchanged `opts`) keeps the daily cap exactly as before.
 */
describe("ensureActiveLibraryBlock — manual bulk opt-in (US-22.4, D-108)", () => {
  it("still defers on the daily cap by default, even with a source set (no bypass)", async () => {
    warmSpendUsd = 5;
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: true, source: "manual_bulk" });
    expect(result).toEqual({ status: "deferred_daily_budget" });
    expect(insertedJobs).toHaveLength(0);
  });

  it("bypasses the daily cap when bypassDailyBudget is true, tagging the job source: manual_bulk", async () => {
    warmSpendUsd = 500; // way past the $5/day default — must not matter here
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: false, source: "manual_bulk", bypassDailyBudget: true });
    expect(result.status).toBe("job_pending");
    expect(insertedJobs).toHaveLength(1);
    expect((insertedJobs[0]!.payload as { source: string }).source).toBe("manual_bulk");
  });

  it("still tags source: auto (default) for every existing caller (warmAheadForSubject, unchanged opts)", async () => {
    subjectsData = [{ id: "subj1", name_uk: "Математика", config: {}, active: true, is_stub: false }];
    topicsData = [{ id: "t1", subject_id: "subj1", title: "Тема 1", grade: 6, sort_order: 1, is_current: false }];
    await warmAheadForSubject("fam1", "subj1");
    expect(insertedJobs).toHaveLength(1);
    expect((insertedJobs[0]!.payload as { source: string }).source).toBe("auto");
  });

  it("still joins/dedupes an existing job the same way regardless of bypassDailyBudget", async () => {
    existingJob = { id: "job-existing", status: "queued" };
    const result = await ensureActiveLibraryBlock("fam1", subject, topic, { immediate: false, source: "manual_bulk", bypassDailyBudget: true });
    expect(result).toEqual({ status: "job_pending", jobId: "job-existing" });
    expect(insertedJobs).toHaveLength(0);
  });
});

/**
 * US-22.4 КП-5/КП-6 (D-108): `getTopicWarmupStatuses` — the single source of
 * truth for both the confirm screen's de-dup ($0 for already-handled topics)
 * and the topic-list status badges, shared between the manual bulk path and
 * every automatic ADR-023 trigger (same `library_items`/`jobs` facts).
 */
describe("getTopicWarmupStatuses (US-22.4 КП-5/КП-6)", () => {
  it("returns 'ready' for a topic with an active library block, regardless of any job history", async () => {
    libraryItemsData = [{ topic_id: "t1", kind: "block", status: "active" }];
    const statuses = await getTopicWarmupStatuses("fam1", ["t1"]);
    expect(statuses).toEqual({ t1: "ready" });
  });

  it("maps queued/running/failed jobs to queued/generating/error", async () => {
    scopeJobsData = [
      { type: "library.warm_topic", dedupe_key: warmDedupeKey("t1"), status: "queued", created_at: "3" },
      { type: "library.warm_topic", dedupe_key: warmDedupeKey("t2"), status: "running", created_at: "3" },
      { type: "library.warm_topic", dedupe_key: warmDedupeKey("t3"), status: "failed", created_at: "3" },
    ];
    const statuses = await getTopicWarmupStatuses("fam1", ["t1", "t2", "t3"]);
    expect(statuses).toEqual({ t1: "queued", t2: "generating", t3: "error" });
  });

  it("leaves a never-touched topic out of the result entirely (no badge)", async () => {
    const statuses = await getTopicWarmupStatuses("fam1", ["t1"]);
    expect(statuses).toEqual({});
  });

  it("picks the MOST RECENT job per topic when a dedupe_key has more than one row (failed retry then a fresh queue)", async () => {
    // Deliberately inserted OLDEST-first, to prove the result comes from
    // sorting by created_at (desc) rather than from array/insertion order.
    scopeJobsData = [
      { type: "library.warm_topic", dedupe_key: warmDedupeKey("t1"), status: "failed", created_at: "1" },
      { type: "library.warm_topic", dedupe_key: warmDedupeKey("t1"), status: "queued", created_at: "2" },
    ];
    const statuses = await getTopicWarmupStatuses("fam1", ["t1"]);
    expect(statuses).toEqual({ t1: "queued" });
  });
});

/**
 * US-22.4 КП-2/КП-3 (D-108): `estimateBulkWarmup` — the exact pre-confirmation
 * numbers the overlay shows, including the monthly-budget block that has NO
 * exception (unlike the daily soft cap this slice bypasses elsewhere).
 */
describe("estimateBulkWarmup (US-22.4 КП-2/КП-3)", () => {
  it("excludes already-ready and already-queued/running topics from the cost", async () => {
    libraryItemsData = [{ topic_id: "t1", kind: "block", status: "active" }];
    scopeJobsData = [{ type: "library.warm_topic", dedupe_key: warmDedupeKey("t2"), status: "running", created_at: "1" }];
    const estimate = await estimateBulkWarmup("fam1", ["t1", "t2", "t3", "t4"]);
    expect(estimate.selectedCount).toBe(4);
    expect(estimate.readyCount).toBe(2); // t1 (active), t2 (running)
    expect(estimate.neededCount).toBe(2); // t3, t4
    expect(estimate.estimatedCostUsd).toBeCloseTo(2 * WARM_TOPIC_COST_USD, 5);
  });

  it("flags exceedsAwarenessThreshold once the estimate passes $10 (КП-4)", async () => {
    const ids = Array.from({ length: 31 }, (_, i) => `t${i}`); // 31 × 0.33 ≈ $10.23
    const estimate = await estimateBulkWarmup("fam1", ids);
    expect(estimate.exceedsAwarenessThreshold).toBe(true);
  });

  it("does NOT flag wouldExceedMonthlyLimit while comfortably under the monthly limit", async () => {
    budgetSpentUsd = 10;
    budgetLimitUsd = 100;
    const estimate = await estimateBulkWarmup("fam1", ["t1", "t2"]);
    expect(estimate.wouldExceedMonthlyLimit).toBe(false);
  });

  it("flags wouldExceedMonthlyLimit once spent + estimate would reach 100% of the monthly limit (ADR-012, no exceptions)", async () => {
    budgetSpentUsd = 99.9;
    budgetLimitUsd = 100;
    const estimate = await estimateBulkWarmup("fam1", ["t1"]); // + $0.33 => 100.23% >= 100%
    expect(estimate.wouldExceedMonthlyLimit).toBe(true);
  });

  it("is unaffected by the daily warm-up soft cap being exhausted — that check belongs to ensureActiveLibraryBlock, not the estimate", async () => {
    warmSpendUsd = 999; // the DAILY cap — must have zero effect on the estimate or the monthly-limit check
    budgetSpentUsd = 1;
    budgetLimitUsd = 100;
    const estimate = await estimateBulkWarmup("fam1", ["t1", "t2"]);
    expect(estimate.neededCount).toBe(2);
    expect(estimate.wouldExceedMonthlyLimit).toBe(false);
  });
});
