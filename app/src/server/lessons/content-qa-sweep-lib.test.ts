import { describe, expect, it } from "vitest";
import {
  checkItemSteps,
  isHighConfidenceFailure,
  matchesKnownDefectiveBook,
  runContentQaSweep,
  toGeneratedStep,
  type RawStepRow,
} from "./content-qa-sweep-lib";
import type { ContentQaFailure } from "./content-qa";

/**
 * ADR-034 § "Ретроактивний sweep" — unit tests for the sweep script's pure
 * glue: reconstructing a saved `library_steps` row into a `GeneratedStep`,
 * the high-confidence/borderline split that decides auto-`needs_review`, and
 * the BUG-046 known-defect-book name match. The actual rule logic
 * (`checkStepContentQa`/`checkVerbatimFidelity`) is already covered by
 * `content-qa.test.ts` — these tests only prove the reconstruction is wired
 * correctly, not the rules themselves.
 */

function slideRow(overrides: Partial<RawStepRow> = {}): RawStepRow {
  return {
    id: "s1",
    sort_order: 0,
    type: "slide",
    content: { textUk: "Це повне речення.", exampleUk: null },
    visual: {},
    source_refs: [],
    ...overrides,
  };
}

describe("toGeneratedStep", () => {
  it("reconstructs a slide step from its saved content", () => {
    const step = toGeneratedStep(slideRow());
    expect(step).toEqual({ type: "slide", textUk: "Це повне речення.", exampleUk: undefined, sourceRefs: [] });
  });

  it("reconstructs a choice step, including remediation when present", () => {
    const row = slideRow({
      type: "choice",
      content: {
        questionUk: "Скільки буде 2+2?",
        options: [{ id: "a", textUk: "4" }, { id: "b", textUk: "5" }],
        correctOptionId: "a",
        explanationUk: "Бо два плюс два дорівнює чотири.",
      },
    });
    const step = toGeneratedStep(row);
    expect(step).toMatchObject({ type: "choice", questionUk: "Скільки буде 2+2?", correctOptionId: "a" });
  });

  it("reconstructs an open step from content", () => {
    const row = slideRow({
      type: "open",
      content: { questionUk: "Поясни правило.", expectedAnswerUk: "Відповідь.", rubricUk: "Критерій." },
    });
    expect(toGeneratedStep(row)).toMatchObject({ type: "open", questionUk: "Поясни правило." });
  });

  it("reconstructs an interactive step's fallback text from `visual`, not `content`", () => {
    const row = slideRow({ type: "interactive", content: {}, visual: { component: "drag_sort", v: 1, fallback_text: "Резервний текст завдання." } });
    expect(toGeneratedStep(row)).toMatchObject({ type: "interactive", component: "drag_sort", fallbackTextUk: "Резервний текст завдання." });
  });

  it("returns null for a step type content_qa does not cover (not produced by lesson_generation today)", () => {
    expect(toGeneratedStep(slideRow({ type: "voice_dialog" }))).toBeNull();
    expect(toGeneratedStep(slideRow({ type: "mini_game" }))).toBeNull();
  });
});

describe("checkItemSteps", () => {
  it("flags a truncated slide step and counts it as checked, not skipped", async () => {
    const rows = [slideRow({ content: { textUk: "Ми вивчили дроби і", exampleUk: null } })];
    const result = await checkItemSteps(rows, async () => null);
    expect(result.checkedSteps).toBe(1);
    expect(result.skippedSteps).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.code).toBe("completeness");
  });

  it("passes a complete, correctly-encoded slide step with no source_refs", async () => {
    const rows = [slideRow()];
    const result = await checkItemSteps(rows, async () => null);
    expect(result.failures).toHaveLength(0);
  });

  it("skips an uncovered step type and reports it in skippedSteps", async () => {
    const rows = [slideRow({ type: "photo" })];
    const result = await checkItemSteps(rows, async () => null);
    expect(result.checkedSteps).toBe(0);
    expect(result.skippedSteps).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("runs verbatim fidelity against the looked-up chunk text for a verbatim-marked slide (BUG-011 fallback path)", async () => {
    const rows = [
      slideRow({
        content: { textUk: "Це уривок з підручника про дроби.", exampleUk: null },
        source_refs: [{ materialId: "m1", page: 4, verbatim: true }],
      }),
    ];
    const okResult = await checkItemSteps(rows, async () => "Вступ. Це уривок з підручника про дроби. Далі текст.");
    expect(okResult.failures).toHaveLength(0);

    const mismatchResult = await checkItemSteps(rows, async () => "Цей текст зовсім про інше.");
    expect(mismatchResult.failures.some((f) => f.code === "fidelity")).toBe(true);
  });

  it("does not fidelity-check a non-verbatim source ref", async () => {
    const rows = [slideRow({ source_refs: [{ materialId: "m1", page: 4, verbatim: false }] })];
    const result = await checkItemSteps(rows, async () => "цілком інший текст, що не збігається");
    expect(result.failures).toHaveLength(0);
  });

  it("skips the fidelity check when the referenced chunk is missing (not this check's job to flag that)", async () => {
    const rows = [slideRow({ source_refs: [{ materialId: "m1", page: 4, verbatim: true }] })];
    const result = await checkItemSteps(rows, async () => null);
    expect(result.failures).toHaveLength(0);
  });
});

describe("isHighConfidenceFailure", () => {
  const base = { stepIndex: 0, field: "textUk" } as const;
  it("treats completeness as high confidence", () => {
    expect(isHighConfidenceFailure({ ...base, code: "completeness", reason: "обрив" } as ContentQaFailure)).toBe(true);
  });
  it("treats fidelity as high confidence", () => {
    expect(isHighConfidenceFailure({ ...base, code: "fidelity", reason: "не знайдено дослівно" } as ContentQaFailure)).toBe(true);
  });
  it("treats the narrow BUG-046 encoding signature as high confidence", () => {
    expect(isHighConfidenceFailure({ ...base, code: "encoding", reason: "виглядає як пошкоджене кодування (BUG-046)" } as ContentQaFailure)).toBe(true);
  });
  it("treats the generic density encoding failure as borderline (NOT high confidence)", () => {
    expect(isHighConfidenceFailure({ ...base, code: "encoding", reason: "надто велика частка символів поза очікуваним діапазоном" } as ContentQaFailure)).toBe(false);
  });
});

describe("matchesKnownDefectiveBook (BUG-046)", () => {
  it("matches the confirmed BUG-046 filename pattern", () => {
    expect(matchesKnownDefectiveBook("6-klas-zarlit-kovbasenko-2023.pdf", null)).toBe(true);
  });
  it("matches the confirmed BUG-046 Ukrainian title", () => {
    expect(matchesKnownDefectiveBook(null, "Зарубіжна література, 6 клас")).toBe(true);
  });
  it("does not match an unrelated book", () => {
    expect(matchesKnownDefectiveBook("matematyka-6-klas.pdf", "Математика, 6 клас")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `runContentQaSweep` — the shared DB orchestration used by both the CLI
// script and the parent-cabinet server action (`runContentQaSweepAction`).
// A small generic fake Supabase client (same style as `warmup.test.ts`'s
// `makeSelectBuilder`), scriptable enough to cover the dry-run-vs-apply
// distinction without a live database.
// ---------------------------------------------------------------------------

type FakeRow = Record<string, unknown>;

function makeFakeClient(store: Record<string, FakeRow[]>) {
  function tableBuilder(table: string) {
    store[table] ??= [];
    const filters: ((r: FakeRow) => boolean)[] = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let mode: "select" | "update" | "insert" = "select";
    let updatePayload: Record<string, unknown> | null = null;
    let insertPayload: Record<string, unknown> | null = null;

    const applyFilters = (rows: FakeRow[]) => rows.filter((r) => filters.every((f) => f(r)));
    const readResult = () => {
      let result = applyFilters(store[table]!);
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => (orderAsc ? String(a[col]).localeCompare(String(b[col])) : String(b[col]).localeCompare(String(a[col]))));
      }
      if (limitN != null) result = result.slice(0, limitN);
      return result;
    };

    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals);
        filters.push((r) => set.has(r[col]));
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
      update: (payload: Record<string, unknown>) => {
        mode = "update";
        updatePayload = payload;
        return builder;
      },
      insert: (payload: Record<string, unknown>) => {
        mode = "insert";
        insertPayload = payload;
        return builder;
      },
      returns: () => builder,
      maybeSingle: async () => ({ data: readResult()[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
        if (mode === "update") {
          for (const r of applyFilters(store[table]!)) Object.assign(r, updatePayload);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        }
        if (mode === "insert") {
          const row = { id: `row-${store[table]!.length + 1}`, ...insertPayload };
          store[table]!.push(row);
          return Promise.resolve({ data: row, error: null }).then(resolve);
        }
        return Promise.resolve({ data: readResult(), error: null }).then(resolve);
      },
    };
    return builder;
  }
  return { from: tableBuilder } as unknown as Parameters<typeof runContentQaSweep>[0];
}

function fallbackLibraryItem(overrides: FakeRow = {}): FakeRow {
  return { id: "item-1", owner_family_id: "fam-1", kind: "block", status: "fallback", topic_id: "topic-1", source_refs: [], ...overrides };
}

function truncatedSlideStep(itemId: string): FakeRow {
  return { id: "step-1", item_id: itemId, sort_order: 0, type: "slide", content: { textUk: "Ми вивчили дроби і", exampleUk: null }, visual: {}, source_refs: [] };
}

function okSlideStep(itemId: string): FakeRow {
  return { id: "step-1", item_id: itemId, sort_order: 0, type: "slide", content: { textUk: "Це повне речення.", exampleUk: null }, visual: {}, source_refs: [] };
}

describe("runContentQaSweep", () => {
  it("dry run: flags a truncated fallback item but writes nothing to the DB", async () => {
    const store: Record<string, FakeRow[]> = {
      library_items: [fallbackLibraryItem()],
      materials: [],
      topics: [],
      library_steps: [truncatedSlideStep("item-1")],
      session_blocks: [],
      library_item_reviews: [],
    };
    const client = makeFakeClient(store);

    const summary = await runContentQaSweep(client, { apply: false });

    expect(summary.mode).toBe("dry_run");
    expect(summary.totals.checked).toBe(1);
    expect(summary.totals.flagged).toBe(1);
    expect(summary.totals.autoTransitioned).toBe(1); // completeness is high-confidence
    expect(summary.counts.fallback.flagged).toBe(1);
    expect(summary.flaggedDetails).toHaveLength(1);

    // Nothing written: the row is untouched.
    expect(store.library_items![0]!.content_qa).toBeUndefined();
    expect(store.library_items![0]!.status).toBe("fallback");
    expect(store.library_item_reviews).toHaveLength(0);
  });

  it("apply: writes content_qa, transitions status for a high-confidence failure, and inserts an audit review row", async () => {
    const store: Record<string, FakeRow[]> = {
      library_items: [fallbackLibraryItem()],
      materials: [],
      topics: [],
      library_steps: [truncatedSlideStep("item-1")],
      session_blocks: [],
      library_item_reviews: [],
    };
    const client = makeFakeClient(store);

    const summary = await runContentQaSweep(client, { apply: true });

    expect(summary.mode).toBe("apply");
    expect(summary.totals.flagged).toBe(1);

    const item = store.library_items![0]!;
    expect(item.status).toBe("needs_review");
    expect(item.needs_review_reason).toBe("technical");
    expect((item.content_qa as { status: string }).status).toBe("flagged");
    expect(store.library_item_reviews).toHaveLength(1);
    expect(store.library_item_reviews![0]!.reviewer_role).toBe("content_qa");
    expect(store.library_item_reviews![0]!.verdict).toBe("rejected");
  });

  it("apply: a passing item is written as checked_ok but never transitions status", async () => {
    const store: Record<string, FakeRow[]> = {
      library_items: [fallbackLibraryItem({ id: "item-2" })],
      materials: [],
      topics: [],
      library_steps: [okSlideStep("item-2")],
      session_blocks: [],
      library_item_reviews: [],
    };
    const client = makeFakeClient(store);

    const summary = await runContentQaSweep(client, { apply: true });

    expect(summary.totals.flagged).toBe(0);
    const item = store.library_items![0]!;
    expect((item.content_qa as { status: string }).status).toBe("checked_ok");
    expect(item.status).toBe("fallback"); // never touched for a passing item
    expect(store.library_item_reviews).toHaveLength(0);
  });

  it("dry run: a passing item writes nothing at all, not even checked_ok", async () => {
    const store: Record<string, FakeRow[]> = {
      library_items: [fallbackLibraryItem({ id: "item-3" })],
      materials: [],
      topics: [],
      library_steps: [okSlideStep("item-3")],
      session_blocks: [],
      library_item_reviews: [],
    };
    const client = makeFakeClient(store);

    await runContentQaSweep(client, { apply: false });

    expect(store.library_items![0]!.content_qa).toBeUndefined();
  });

  it("respects `limit` and reports the category breakdown before the cap", async () => {
    const store: Record<string, FakeRow[]> = {
      library_items: [fallbackLibraryItem({ id: "a" }), fallbackLibraryItem({ id: "b" })],
      materials: [],
      topics: [],
      library_steps: [okSlideStep("a"), okSlideStep("b")],
      session_blocks: [],
      library_item_reviews: [],
    };
    const client = makeFakeClient(store);

    const summary = await runContentQaSweep(client, { apply: false, limit: 1 });

    expect(summary.targetCounts.total).toBe(1);
    expect(summary.targetCounts.totalBeforeLimit).toBe(2);
    expect(summary.totals.checked).toBe(1);
  });
});
