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

const scope = {
  count: () => {
    const self = { eq: () => self, then: (res: (v: unknown) => unknown) => Promise.resolve({ count: activeCount }).then(res) };
    return self;
  },
  select: (table: string) => makeSelectBuilder(table === "subjects" ? subjectsData : table === "topics" ? topicsData : []),
};
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => scope }));

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
vi.mock("./generate", () => ({
  generateOneBlock: (...a: unknown[]) => generateOneBlockMock(...a),
  loadCandidates: (...a: unknown[]) => loadCandidatesMock(...a),
}));

const { ensureActiveLibraryBlock, warmAheadForSubject, registerLibraryWarmJobs, warmDedupeKey } = await import("./warmup");

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
