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

/** A tiny thenable query-builder stand-in for `forFamily(...)`'s chainable API. */
function makeScope(tables: Record<string, FakeRow[] | FakeRow>, updates: { table: string; values: FakeRow }[]) {
  function builder(table: string, mode: "single" | "many") {
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
      resolve() {
        const rows = tables[table];
        const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
        const matched = list.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)));
        if (mode === "single") return { data: matched[0] ?? null, error: null };
        return { data: matched, error: null };
      },
      maybeSingle: () => Promise.resolve(self.resolve()),
      single: () => Promise.resolve(self.resolve()),
      returns: () => Promise.resolve(self.resolve()),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(self.resolve()).then(res, rej),
    };
    return self;
  }
  return {
    select: (table: string) => builder(table, table === "lesson_sessions" || table === "subjects" || table === "topics" ? "single" : "many"),
    update: (table: string, values: FakeRow) => {
      updates.push({ table, values });
      return builder(table, "single");
    },
    client: { from: () => ({ insert: () => Promise.resolve({ data: null, error: null }) }) },
  };
}

const scopeState = { tables: {} as Record<string, FakeRow[] | FakeRow>, updates: [] as { table: string; values: FakeRow }[] };
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => makeScope(scopeState.tables, scopeState.updates) }));

const nextSessionBlock = vi.fn();
const loadLibraryItem = vi.fn();
const getOrGenerateLessonBlocks = vi.fn();
vi.mock("./generate", () => ({
  nextSessionBlock: (...a: unknown[]) => nextSessionBlock(...a),
  loadLibraryItem: (...a: unknown[]) => loadLibraryItem(...a),
  getOrGenerateLessonBlocks: (...a: unknown[]) => getOrGenerateLessonBlocks(...a),
}));

const { continueAfterBlock, resumeLessonSession } = await import("./orchestrator");

function resetScope() {
  scopeState.tables = {};
  scopeState.updates = [];
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
