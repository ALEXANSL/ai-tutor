import { describe, expect, it } from "vitest";
import { checkItemSteps, isHighConfidenceFailure, matchesKnownDefectiveBook, toGeneratedStep, type RawStepRow } from "./content-qa-sweep-lib";
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
