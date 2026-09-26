import { describe, expect, it, vi } from "vitest";

/**
 * Orchestrator regression tests for BUG-008 (resume reminder wiring) and
 * BUG-009 (a block must not repeat within one session). `@/server/db/family-
 * scope` and `@/server/lessons/generate` are mocked — this is not a DB test
 * (see `tests/db/s3-lessons.test.ts` for RLS); it is here to prove the two
 * bugs' *wiring*, which a pure-function unit test cannot.
 */

interface FakeRow {
  [k: string]: unknown;
}

/**
 * A tiny thenable query-builder stand-in for `forFamily(...)`'s chainable
 * API. QA note: single-vs-array shape is decided by the *terminal method the
 * production code actually calls* (`maybeSingle`/`single` -> one row or
 * `null`; `returns`/bare `then` -> an array) rather than by a fixed per-table
 * guess — the same table (e.g. `step_attempts`) is read both ways in
 * `submitStepAnswer` (a `maybeSingle()` idempotency lookup and a `returns()`
 * history list), so a table-name-based mode would silently mis-shape one of
 * the two and was only "safe" before because no existing test exercised
 * `submitStepAnswer` at all.
 */
function makeScope(tables: Record<string, FakeRow[] | FakeRow>, updates: { table: string; values: FakeRow }[]) {
  function builder(table: string, isUpdate = false) {
    const filters: [string, unknown][] = [];
    const self = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return self;
      },
      order() {
        return self;
      },
      limit() {
        return self;
      },
      in(col: string, vals: unknown[]) {
        filters.push([col, vals]);
        return self;
      },
      select() {
        return self;
      },
      matched() {
        const rows = tables[table];
        const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
        return list.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)));
      },
      maybeSingle: () => Promise.resolve({ data: self.matched()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: self.matched()[0] ?? null, error: null }),
      returns: () => Promise.resolve({ data: self.matched(), error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(
          isUpdate && updateErrorOverride && updateErrorOverride.table === table
            ? { data: null, error: updateErrorOverride.error }
            : { data: self.matched(), error: null },
        ).then(res, rej),
    };
    return self;
  }
  return {
    select: (table: string) => builder(table),
    update: (table: string, values: FakeRow) => {
      updates.push({ table, values });
      return builder(table, true);
    },
    client: {
      from: (...args: unknown[]) =>
        clientFromOverride
          ? clientFromOverride(...(args as [string]))
          : {
              insert: () => ({
                select: () => ({ single: () => Promise.resolve({ data: { id: "s1" }, error: null }) }),
              }),
            },
    },
  };
}

/**
 * A per-test escape hatch for `scope.client.from(...)` (BUG-016 test only):
 * lets one test simulate a rejected write without changing the shared fake
 * for every other test in this file.
 */
let clientFromOverride: ((table: string) => { insert: (row: unknown) => unknown }) | null = null;

/**
 * A per-test escape hatch for `scope.update(table, ...).eq(...)` (BUG-016
 * exploratory tests, `qa-tester`): lets one test simulate a rejected *second*
 * write (the `lesson_sessions` update in `activateBlock`, distinct from the
 * `session_blocks` insert already covered above) without touching every
 * other test in this file.
 */
let updateErrorOverride: { table: string; error: { message: string } } | null = null;

const scopeState = { tables: {} as Record<string, FakeRow[] | FakeRow>, updates: [] as { table: string; values: FakeRow }[] };
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => makeScope(scopeState.tables, scopeState.updates) }));

const nextSessionBlock = vi.fn();
const loadLibraryItem = vi.fn();
const getOrGenerateLessonBlocks = vi.fn();
const getOrCreateFallbackBlock = vi.fn();
const notifyParent = vi.fn().mockResolvedValue(undefined);
vi.mock("./generate", () => ({
  nextSessionBlock: (...a: unknown[]) => nextSessionBlock(...a),
  loadLibraryItem: (...a: unknown[]) => loadLibraryItem(...a),
  getOrGenerateLessonBlocks: (...a: unknown[]) => getOrGenerateLessonBlocks(...a),
  getOrCreateFallbackBlock: (...a: unknown[]) => getOrCreateFallbackBlock(...a),
}));
vi.mock("@/server/notifications", () => ({ notifyParent: (...a: unknown[]) => notifyParent(...a) }));

const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...a: unknown[]) => callStructured(...a) }));
const moderateMessage = vi.fn();
vi.mock("@/server/safety/moderate", () => ({ moderateMessage: (...a: unknown[]) => moderateMessage(...a) }));
const recordSafetyEvent = vi.fn().mockResolvedValue({ flagged: false, urgent: false, eventId: null });
vi.mock("@/server/safety/events", () => ({ recordSafetyEvent: (...a: unknown[]) => recordSafetyEvent(...a) }));

const { chooseStartBlock, continueAfterBlock, pauseLessonSession, resumeLessonSession, startLessonSession, submitStepAnswer } = await import("./orchestrator");

function resetScope() {
  scopeState.tables = {};
  scopeState.updates = [];
  clientFromOverride = null;
  nextSessionBlock.mockClear();
  loadLibraryItem.mockClear();
  getOrGenerateLessonBlocks.mockClear();
  getOrCreateFallbackBlock.mockClear();
  notifyParent.mockClear();
  callStructured.mockClear();
  moderateMessage.mockClear();
  recordSafetyEvent.mockClear().mockResolvedValue({ flagged: false, urgent: false, eventId: null });
}

describe("continueAfterBlock (BUG-009: no block repeats within one session)", () => {
  it("passes the FULL session history (every session_blocks row), not just the block that just finished", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", active_seconds: 300, planned_minutes: 30, subject_id: "subj1", topic_id: "top1" },
      subjects: { id: "subj1", name_uk: "Математика", config: {} },
      topics: { id: "top1", title: "Дроби", grade: 6 },
      session_blocks: [
        { session_id: "s1", library_item_id: "A" },
        { session_id: "s1", library_item_id: "B" },
      ],
    };
    nextSessionBlock.mockResolvedValue({ id: "C", title: "Блок C", estimatedMinutes: 7 });
    loadLibraryItem.mockResolvedValue({ id: "C", title: "Блок C", estimatedMinutes: 7, visibleOutcomeUk: null, steps: [{ id: "st1", sortOrder: 0, type: "slide", content: {}, visual: {}, sourceRefs: [] }] });

    await continueAfterBlock("fam1", "s1");

    expect(nextSessionBlock).toHaveBeenCalledTimes(1);
    const usedIds = nextSessionBlock.mock.calls[0]![7] as string[];
    expect(usedIds.sort()).toEqual(["A", "B"]); // BOTH blocks, not only the most recent one
  });

  it("ends the lesson early (never repeats silently) when the topic's library is exhausted for this session", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", active_seconds: 300, planned_minutes: 45, subject_id: "subj1", topic_id: "top1" },
      subjects: { id: "subj1", name_uk: "Математика", config: {} },
      topics: { id: "top1", title: "Дроби", grade: 6 },
      session_blocks: [{ session_id: "s1", library_item_id: "A" }],
    };
    nextSessionBlock.mockResolvedValue(null); // generation also failed to produce a fresh block

    const next = await continueAfterBlock("fam1", "s1");

    expect(next).toEqual({ kind: "lesson_complete" });
    expect(scopeState.updates.some((u) => u.table === "lesson_sessions" && u.values.status === "completed")).toBe(true);
  });
});

describe("startLessonSession — BUG-011: US-6.11 requires a 'safe simplified template' fallback " +
  "when every generated block ends up needs_review, but none exists yet", () => {
  it("starts the lesson with the safe fallback block (not a thrown error) when the reviewer is unavailable", async () => {
    resetScope();
    scopeState.tables = {
      subjects: { id: "subj1", name_uk: "Математика", config: {} },
      topics: { id: "top1", title: "Дроби", grade: 6 },
    };
    // Every pipeline attempt ended in `needs_review` (e.g. `lesson_review`
    // hitting `AiNotConfiguredError` because `OPENAI_API_KEY` is unset, the
    // exact scenario `docs/STATUS.md` warns is likely at first demo) — no
    // "active" block was ever produced for this topic, so
    // `getOrGenerateLessonBlocks` reports the empty result + a reason.
    getOrGenerateLessonBlocks.mockResolvedValue({
      candidates: [],
      failureReasonUk: "рецензент недоступний: не налаштовано OPENAI_API_KEY",
    });
    getOrCreateFallbackBlock.mockResolvedValue({ id: "fallback1", title: "Резервний блок: Дроби", estimatedMinutes: 5 });

    const result = await startLessonSession("fam1", "child1", "subj1", "top1", 30);

    expect(result.sessionId).toBe("s1");
    expect(result.usedFallback).toBe(true);
    expect(result.candidates).toEqual([{ libraryItemId: "fallback1", title: "Резервний блок: Дроби", estimatedMinutes: 5 }]);
    expect(getOrCreateFallbackBlock).toHaveBeenCalledWith("fam1", "subj1", "top1", "Дроби", 6);
    // The parent gets a notification naming the actual reason, not a generic error.
    expect(notifyParent).toHaveBeenCalledWith(
      "fam1",
      expect.objectContaining({
        type: "lesson_started_with_fallback",
        payload: expect.objectContaining({ reason: "рецензент недоступний: не налаштовано OPENAI_API_KEY" }),
      }),
    );
  });

  it("starts normally (no fallback, no notification) when generation produced real candidates", async () => {
    resetScope();
    scopeState.tables = {
      subjects: { id: "subj1", name_uk: "Математика", config: {} },
      topics: { id: "top1", title: "Дроби", grade: 6 },
    };
    getOrGenerateLessonBlocks.mockResolvedValue({
      candidates: [{ id: "a", title: "Блок A", estimatedMinutes: 7 }],
      failureReasonUk: null,
    });

    const result = await startLessonSession("fam1", "child1", "subj1", "top1", 30);

    expect(result.usedFallback).toBe(false);
    expect(result.candidates).toEqual([{ libraryItemId: "a", title: "Блок A", estimatedMinutes: 7 }]);
    expect(getOrCreateFallbackBlock).not.toHaveBeenCalled();
    expect(notifyParent).not.toHaveBeenCalled();
  });

  it("ends the lesson after the current block when time is already up, without even asking for a next block", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", active_seconds: 1800, planned_minutes: 30, subject_id: "subj1", topic_id: "top1" },
    };
    const next = await continueAfterBlock("fam1", "s1");
    expect(next).toEqual({ kind: "lesson_complete" });
    expect(nextSessionBlock).not.toHaveBeenCalled();
  });
});

describe("resumeLessonSession (BUG-008: 24h+ pause reminder is actually wired)", () => {
  it("returns a reminder built from the active block's own opening slide after a 24h+ pause", async () => {
    resetScope();
    const pausedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    scopeState.tables = {
      lesson_sessions: { id: "s1", family_id: "fam1", current_block_order: 1, current_step_id: "st1", paused_at: pausedAt },
      session_blocks: [{ session_id: "s1", sort_order: 1, library_item_id: "A" }],
    };
    loadLibraryItem.mockResolvedValue({
      id: "A",
      title: "Блок A",
      estimatedMinutes: 7,
      visibleOutcomeUk: null,
      steps: [
        { id: "st1", sortOrder: 0, type: "slide", content: { textUk: "Уяви, що піцу ділять двоє друзів..." }, visual: {}, sourceRefs: [] },
      ],
    });

    const result = await resumeLessonSession("fam1", "s1");

    expect(result.reminder).toEqual({ textUk: "Уяви, що піцу ділять двоє друзів..." });
    expect(scopeState.updates.some((u) => u.table === "lesson_sessions" && u.values.status === "active")).toBe(true);
  });

  it("does NOT return a reminder for a short pause", async () => {
    resetScope();
    const pausedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    scopeState.tables = {
      lesson_sessions: { id: "s1", family_id: "fam1", current_block_order: 1, current_step_id: "st1", paused_at: pausedAt },
      session_blocks: [{ session_id: "s1", sort_order: 1, library_item_id: "A" }],
    };
    loadLibraryItem.mockResolvedValue({ id: "A", title: "Блок A", estimatedMinutes: 7, visibleOutcomeUk: null, steps: [{ id: "st1", sortOrder: 0, type: "slide", content: { textUk: "..." }, visual: {}, sourceRefs: [] }] });

    const result = await resumeLessonSession("fam1", "s1");
    expect(result.reminder).toBeNull();
  });
});

describe("submitStepAnswer + moderation (NFR-SAFE-4, US-12.1 КП-2) — BUG-013 fix", () => {
  /**
   * `chat.ts` (`askTopicChat`) and `friendChat.ts` (`askFriendChat`) both
   * hard-code: `severity === "urgent"` -> the deterministic "піди зараз до
   * тата" reply REPLACES whatever the model said, no matter what. BUG-013:
   * the lesson open-answer path (`submitStepAnswer`) did NOT do the same for
   * the `explanation` text shown to the child — it always used whatever
   * `answer_evaluation` (or the on-device rubric) produced, even when the
   * same message was just classified `severity: "urgent"` and a
   * `safety_events`/external delivery was raised for the parent. Fixed: the
   * same deterministic sentence (`URGENT_REPLY_UK`) now overrides it, and
   * `verdict` is forced to "partial" so the branch logic cannot skip
   * straight ahead ("correct") right after a safety signal. The
   * *notification* to the parent still fires exactly as before
   * (`recordSafetyEvent` is called and, in the app, escalates to
   * e-mail/Telegram).
   */
  const openStep = {
    id: "st1",
    type: "open",
    content: { questionUk: "Як почуваєшся?", expectedAnswerUk: "—", rubricUk: "—" },
    visual: {},
    source_refs: [],
  };

  function baseTables() {
    return {
      lesson_sessions: { id: "s1", current_step_id: "st1", current_block_order: 1, subject_id: "subj1", topic_id: "top1", child_profile_id: "child1" },
      library_steps: openStep,
      step_attempts: [],
      session_blocks: [{ session_id: "s1", sort_order: 1, library_item_id: "A" }],
    };
  }

  it("an 'urgent' open answer ALWAYS gets the deterministic go-to-dad reply, never the model's own explanation", async () => {
    resetScope();
    scopeState.tables = baseTables();
    moderateMessage.mockResolvedValue({ category: "self_harm", severity: "urgent", confidence: 0.95, reasonUk: "x", layer1Flagged: true, escalated: false });
    callStructured.mockResolvedValue({ result: { verdict: "partial", explanationUk: "Гарна спроба, продовжуй!" }, model: {}, costUsd: 0, fallbackUsed: false });
    loadLibraryItem.mockResolvedValue({ id: "A", title: "Блок A", estimatedMinutes: 7, visibleOutcomeUk: null, steps: [{ id: "st1", sortOrder: 0, type: "open", content: openStep.content, visual: {}, sourceRefs: [] }, { id: "st2", sortOrder: 1, type: "slide", content: {}, visual: {}, sourceRefs: [] }] });

    const result = await submitStepAnswer("fam1", "s1", "st1", "idem-1", "text", { text: "я хочу собі зашкодити" }, 4000);

    expect(recordSafetyEvent).toHaveBeenCalledWith(
      "fam1", "child1", "lesson", "я хочу собі зашкодити",
      expect.objectContaining({ severity: "urgent" }),
      expect.objectContaining({ sessionId: "s1" }),
    );
    // BUG-013 fix: overrides the model's own feedback with the same
    // deterministic sentence chat.ts/friendChat.ts use, and does not
    // silently advance past it as "correct".
    expect(result.explanation).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
    expect(result.verdict).toBe("partial");
    expect(result.next).toEqual({ kind: "retry_step" });
  });

  it("a non-urgent (normal) moderation result does NOT override the model's own pedagogical explanation", async () => {
    resetScope();
    scopeState.tables = baseTables();
    moderateMessage.mockResolvedValue({ category: "sadness", severity: "normal", confidence: 0.8, reasonUk: "x", layer1Flagged: false, escalated: false });
    callStructured.mockResolvedValue({ result: { verdict: "correct", explanationUk: "Гарна спроба, продовжуй!" }, model: {}, costUsd: 0, fallbackUsed: false });
    loadLibraryItem.mockResolvedValue({ id: "A", title: "Блок A", estimatedMinutes: 7, visibleOutcomeUk: null, steps: [{ id: "st1", sortOrder: 0, type: "open", content: openStep.content, visual: {}, sourceRefs: [] }, { id: "st2", sortOrder: 1, type: "slide", content: {}, visual: {}, sourceRefs: [] }] });

    const result = await submitStepAnswer("fam1", "s1", "st1", "idem-1", "text", { text: "мені трохи сумно" }, 4000);

    expect(result.explanation).toBe("Гарна спроба, продовжуй!");
    expect(result.verdict).toBe("correct");
  });
});

describe("chooseStartBlock (BUG-016: picking an offered block after a real generation must not crash the lesson screen)", () => {
  /**
   * A realistic multi-step block — one of *every* step shape
   * `generate.ts#toStepRow` actually produces from a real, reviewed
   * pipeline output (slide, choice, open, and a validated `drag_sort`
   * interactive), each carrying real `sourceRefs` — unlike the
   * single-slide, empty-`sourceRefs` fixtures the rest of this file uses.
   * BUG-016 (from a live demo): choosing a block sent the child to Next's
   * generic "a server error occurred" page instead of the next step; this
   * locks down that `chooseStartBlock` handles this full shape cleanly and
   * that a rejected write is a specific, catchable `Error` — never silently
   * swallowed and never an unrelated crash later.
   */
  const realisticItem = {
    id: "blk1",
    title: "Відсотки: як знайти відсотки від числа",
    estimatedMinutes: 8,
    visibleOutcomeUk: "Тепер ти вмієш рахувати відсотки від числа!",
    steps: [
      {
        id: "st1",
        sortOrder: 0,
        type: "slide",
        content: { textUk: "Відсоток — це сота частина числа.", exampleUk: "10% від 200 — це 20." },
        visual: {},
        sourceRefs: [{ materialId: "mat1", materialTitle: "Математика, підручник", page: 42 }],
      },
      {
        id: "st2",
        sortOrder: 1,
        type: "choice",
        content: {
          questionUk: "Скільки буде 10% від 200?",
          options: [
            { id: "a", textUk: "20" },
            { id: "b", textUk: "10" },
          ],
          correctOptionId: "a",
          explanationUk: "10% — це одна десята, 200 / 10 = 20.",
        },
        visual: {},
        sourceRefs: [{ materialId: "mat1", materialTitle: "Математика, підручник", page: 42 }],
      },
      {
        id: "st3",
        sortOrder: 2,
        type: "open",
        content: { questionUk: "Поясни своїми словами, що таке відсоток.", expectedAnswerUk: "сота частина числа", rubricUk: "приймати будь-яке розумне пояснення" },
        visual: {},
        sourceRefs: [{ materialId: "mat1", materialTitle: "Математика, підручник", page: 43 }],
      },
      {
        id: "st4",
        sortOrder: 3,
        type: "interactive",
        content: {},
        visual: {
          component: "drag_sort",
          v: 1,
          props: {
            instructionUk: "Розстав картки за зростанням.",
            items: [
              { id: "i1", labelUk: "10%" },
              { id: "i2", labelUk: "50%" },
            ],
            slots: [
              { id: "s1", labelUk: "Менше" },
              { id: "s2", labelUk: "Більше" },
            ],
            correctPlacement: { i1: "s1", i2: "s2" },
          },
          fallback_text: "Обери правильну відповідь.",
        },
        sourceRefs: [{ materialId: "mat1", materialTitle: "Математика, підручник", page: 44 }],
      },
    ],
  };

  it("activates the chosen offered block and returns its first step without throwing", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: {
        id: "s1",
        mode: "choosing",
        status: "active",
        current_block_order: 0,
        candidate_library_item_ids: ["blk1", "blk2"],
      },
    };
    loadLibraryItem.mockResolvedValue(realisticItem);

    const step = await chooseStartBlock("fam1", "s1", "blk1");

    expect(step.stepId).toBe("st1");
    expect(step.type).toBe("slide");
    expect(step.totalSteps).toBe(4);
    expect(scopeState.updates).toContainEqual(
      expect.objectContaining({ table: "lesson_sessions", values: expect.objectContaining({ mode: "lesson", current_step_id: "st1", current_block_order: 1 }) }),
    );
  });

  it("rejects a block that was never offered, with a specific catchable error", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", mode: "choosing", status: "active", current_block_order: 0, candidate_library_item_ids: ["blk2"] },
    };
    loadLibraryItem.mockResolvedValue(realisticItem);

    await expect(chooseStartBlock("fam1", "s1", "blk1")).rejects.toThrow("not an offered block");
  });

  it("surfaces a failed session_blocks write as a specific Error instead of silently leaving the session inconsistent", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", mode: "choosing", status: "active", current_block_order: 0, candidate_library_item_ids: ["blk1"] },
    };
    loadLibraryItem.mockResolvedValue(realisticItem);
    clientFromOverride = () => ({
      insert: () => Promise.resolve({ data: null, error: { message: "duplicate key value violates unique constraint" } }),
    });

    try {
      await expect(chooseStartBlock("fam1", "s1", "blk1")).rejects.toThrow(/activating lesson block failed/);
    } finally {
      clientFromOverride = null;
    }
  });

  /**
   * Exploratory (qa-tester, S4 re-verification of BUG-016): the fix's own
   * regression tests above only cover the *one* failure shape from the live
   * demo (a rejected `session_blocks` insert). These three additional
   * failure shapes must *also* surface as a specific, catchable `Error` —
   * never an unhandled rejection — because `chooseStartBlockAction`'s
   * `catch` and the `/lesson/[sessionId]/error.tsx` route boundary are the
   * child's only two safety nets and both depend on every failure inside
   * `chooseStartBlock`/`activateBlock` being a thrown `Error`, not a crash
   * that bypasses `catch` (e.g. a rejected promise chain that isn't awaited,
   * or a TypeError from reading a property of `undefined`).
   */
  it("rejects with a specific error when the session itself cannot be found (e.g. a stale/expired link)", async () => {
    resetScope();
    scopeState.tables = {}; // no lesson_sessions row at all
    await expect(chooseStartBlock("fam1", "missing-session", "blk1")).rejects.toThrow("session not found");
  });

  it("rejects with a specific error for a corrupted library item with zero steps (bad generation output)", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", mode: "choosing", status: "active", current_block_order: 0, candidate_library_item_ids: ["blk1"] },
    };
    loadLibraryItem.mockResolvedValue({ ...realisticItem, steps: [] });
    await expect(chooseStartBlock("fam1", "s1", "blk1")).rejects.toThrow("chosen block has no steps");
  });

  it("rejects with a specific error when loadLibraryItem itself can't find the block (deleted/never generated)", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", mode: "choosing", status: "active", current_block_order: 0, candidate_library_item_ids: ["blk1"] },
    };
    loadLibraryItem.mockResolvedValue(null);
    await expect(chooseStartBlock("fam1", "s1", "blk1")).rejects.toThrow("chosen block has no steps");
  });

  it("surfaces a failed *second* write (lesson_sessions update) as a specific Error, not just the first (session_blocks insert)", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", mode: "choosing", status: "active", current_block_order: 0, candidate_library_item_ids: ["blk1"] },
    };
    loadLibraryItem.mockResolvedValue(realisticItem);
    updateErrorOverride = { table: "lesson_sessions", error: { message: "connection timeout" } };

    try {
      await expect(chooseStartBlock("fam1", "s1", "blk1")).rejects.toThrow(/activating lesson block failed/);
    } finally {
      updateErrorOverride = null;
    }
  });

  it("rejects loadLibraryItem's own downstream failure (e.g. a timed-out/misconfigured fetch) rather than hanging or crashing uncaught", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", mode: "choosing", status: "active", current_block_order: 0, candidate_library_item_ids: ["blk1"] },
    };
    loadLibraryItem.mockRejectedValue(new Error("timeout fetching library item"));
    await expect(chooseStartBlock("fam1", "s1", "blk1")).rejects.toThrow("timeout fetching library item");
  });
});

describe("submitStepAnswer — BUG-019 (objectively correct answers were graded 'partial'/'incorrect')", () => {
  /**
   * Root causes fixed:
   *  1. `LessonRunner.tsx`'s `onInteractiveSubmit` sent `{ component, answer,
   *     correct }` to the server instead of the raw answer shape
   *     `evaluateAnswer`'s "interactive" branch expects
   *     (`def.evaluate(props, answer)`) — every `drag_sort` submission was
   *     graded against the wrong shape and came back `incorrect` no matter
   *     what the child placed. This describe block locks the *server*
   *     contract: the raw answer shape the fixed client now sends must
   *     grade `correct` when it objectively is.
   *  2. The open-answer LLM evaluator had no protection against grading a
   *     right-in-substance answer down for its *format* (a bare number, a
   *     lettered list "а)/б)/в)" instead of full sentences matching the
   *     "Еталон" text's own wording) — a real teacher never does that. A
   *     deterministic substance check now catches the unambiguous cases
   *     before ever asking the model.
   */
  function baseSessionTables(stepRow: FakeRow) {
    // A correct verdict always takes `submitStepAnswer` into `advanceAfterStep`
    // (`decideBranch` only stays on the step for a non-correct first attempt),
    // which loads the block via `loadLibraryItem` to find what comes next —
    // so every test below needs it mocked, even though it is not what BUG-019
    // is about.
    loadLibraryItem.mockResolvedValue({
      id: "A",
      title: "Блок A",
      estimatedMinutes: 7,
      visibleOutcomeUk: "Готово!",
      steps: [{ id: stepRow.id as string, sortOrder: 0, type: stepRow.type as string, content: stepRow.content, visual: stepRow.visual, sourceRefs: [] }],
    });
    return {
      lesson_sessions: { id: "s1", current_step_id: "st1", current_block_order: 1, subject_id: "subj1", topic_id: "top1", child_profile_id: "child1" },
      library_steps: stepRow,
      step_attempts: [],
      session_blocks: [{ session_id: "s1", sort_order: 1, library_item_id: "A" }],
    };
  }

  it("a correct `choice` answer grades `correct` (baseline, unaffected by the fix)", async () => {
    resetScope();
    scopeState.tables = baseSessionTables({
      id: "st1",
      type: "choice",
      content: { questionUk: "Скільки буде 10% від 200?", options: [{ id: "a", textUk: "20" }, { id: "b", textUk: "10" }], correctOptionId: "a", explanationUk: "10% — одна десята." },
      visual: {},
      source_refs: [],
    });

    const result = await submitStepAnswer("fam1", "s1", "st1", "idem-1", "choice", { optionId: "a" }, 3000);

    expect(result.verdict).toBe("correct");
  });

  it("a correct `drag_sort` (interactive) answer, sent as the raw item->slot map, grades `correct` — the exact regression from the wrapped `{ component, answer, correct }` payload the client used to send", async () => {
    resetScope();
    scopeState.tables = baseSessionTables({
      id: "st1",
      type: "interactive",
      content: {},
      visual: {
        component: "drag_sort",
        v: 1,
        props: {
          variant: "pairs",
          instructionUk: "Розстав картки за зростанням.",
          items: [{ id: "i1", labelUk: "10%" }, { id: "i2", labelUk: "50%" }],
          slots: [{ id: "s1", labelUk: "Менше" }, { id: "s2", labelUk: "Більше" }],
          answer: { i1: "s1", i2: "s2" },
        },
        fallback_text: "Обери правильну відповідь.",
      },
      source_refs: [],
    });

    // This is exactly what `LessonRunner.tsx`'s (fixed) `onInteractiveSubmit`
    // now sends: the raw placement, nothing wrapped around it.
    const result = await submitStepAnswer("fam1", "s1", "st1", "idem-1", "text", { i1: "s1", i2: "s2" }, 5000);

    expect(result.verdict).toBe("correct");
  });

  it("an open-answer reply that is JUST a number, matching the reference answer's own number, grades `correct` without even calling the LLM evaluator", async () => {
    resetScope();
    scopeState.tables = baseSessionTables({
      id: "st1",
      type: "open",
      content: { questionUk: "Скільки буде 10% від 20?", expectedAnswerUk: "Правильна відповідь — 2.", rubricUk: "приймати короткий запис" },
      visual: {},
      source_refs: [],
    });
    moderateMessage.mockResolvedValue({ category: "none", severity: "normal", confidence: 0.99, reasonUk: "", layer1Flagged: false, escalated: false });

    const result = await submitStepAnswer("fam1", "s1", "st1", "idem-1", "text", { text: "2" }, 4000);

    expect(result.verdict).toBe("correct");
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("an open-answer reply written as a lettered list ('а) ... б) ... в) ...') that matches the reference answer's content grades `correct`, regardless of the punctuation/spacing difference", async () => {
    resetScope();
    scopeState.tables = baseSessionTables({
      id: "st1",
      type: "open",
      content: { questionUk: "Знайди 25% від 20, 48 і 80.", expectedAnswerUk: "а) 5, б) 12, в) 20.", rubricUk: "приймати будь-який формат запису" },
      visual: {},
      source_refs: [],
    });
    moderateMessage.mockResolvedValue({ category: "none", severity: "normal", confidence: 0.99, reasonUk: "", layer1Flagged: false, escalated: false });

    const result = await submitStepAnswer("fam1", "s1", "st1", "idem-1", "text", { text: "а) 5 б) 12 в) 20" }, 6000);

    expect(result.verdict).toBe("correct");
    expect(callStructured).not.toHaveBeenCalled();
  });

  it("an open-answer reply that does NOT match the reference answer still goes to the LLM evaluator and its verdict is not silently overridden", async () => {
    resetScope();
    scopeState.tables = baseSessionTables({
      id: "st1",
      type: "open",
      content: { questionUk: "Скільки буде 10% від 20?", expectedAnswerUk: "2", rubricUk: "приймати короткий запис" },
      visual: {},
      source_refs: [],
    });
    moderateMessage.mockResolvedValue({ category: "none", severity: "normal", confidence: 0.99, reasonUk: "", layer1Flagged: false, escalated: false });
    callStructured.mockResolvedValue({ result: { verdict: "incorrect", explanationUk: "Це не так, спробуй порахувати ще раз." }, model: {}, costUsd: 0, fallbackUsed: false });

    const result = await submitStepAnswer("fam1", "s1", "st1", "idem-1", "text", { text: "3" }, 4000);

    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe("incorrect");
  });
});

describe("pauseLessonSession — BUG-020 ('Вийти з уроку' preserves resume state, same as any other pause)", () => {
  it("an explicit exit (manual_exit) pauses the session without ever touching current_step_id — the exact step it was on stays resumable", async () => {
    resetScope();
    scopeState.tables = {
      lesson_sessions: { id: "s1", status: "active", current_step_id: "st7", current_block_order: 2, pause_reason: null, paused_at: null },
    };

    await pauseLessonSession("fam1", "s1", "manual_exit");

    const update = scopeState.updates.find((u) => u.table === "lesson_sessions");
    expect(update).toBeTruthy();
    expect(update!.values).toMatchObject({ status: "paused", pause_reason: "manual_exit" });
    // `pauseFor` never mentions `current_step_id` — a pause (of any kind,
    // including this explicit exit) must never clear or move it.
    expect(update!.values.current_step_id).toBeUndefined();
  });

  it("resuming right after an explicit exit reopens the exact same step (no false 24h+ reminder for a same-session exit)", async () => {
    resetScope();
    const pausedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    scopeState.tables = {
      lesson_sessions: { id: "s1", status: "paused", pause_reason: "manual_exit", paused_at: pausedAt, current_step_id: "st1", current_block_order: 1 },
      session_blocks: [{ session_id: "s1", sort_order: 1, library_item_id: "A" }],
    };
    loadLibraryItem.mockResolvedValue({
      id: "A",
      title: "Блок A",
      estimatedMinutes: 7,
      visibleOutcomeUk: null,
      steps: [{ id: "st1", sortOrder: 0, type: "slide", content: { textUk: "..." }, visual: {}, sourceRefs: [] }],
    });

    const result = await resumeLessonSession("fam1", "s1");

    expect(result.step?.stepId).toBe("st1");
    expect(result.reminder).toBeNull();
  });
});
