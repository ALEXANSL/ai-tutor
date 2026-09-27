// @vitest-environment jsdom
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * BUG-029: "⬅️ Попередній модуль" used to render nothing when
 * `getPreviousModuleAction` resolved `null` (no previous block yet — always
 * true on a lesson's first block) — a click that visibly did nothing. This
 * is a real interactive (jsdom) test, not a static-markup snapshot: it
 * clicks the actual button and asserts on what the DOM looks like
 * afterwards, which a `renderToStaticMarkup` test (this repo's other
 * component tests, e.g. `LessonExitLinks.test.tsx`) cannot do.
 *
 * It also covers the button's own visibility (КП-2/BUG-029 item 3): hidden
 * on the first block (`currentBlockOrder` <= 1, the default), shown once a
 * `continueAfterBlockAction` resolves to a new block ("advance").
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const getPreviousModuleAction = vi.fn();
const goToPreviousStepAction = vi.fn();
const continueAfterBlockAction = vi.fn();
const submitStepAnswerAction = vi.fn();
vi.mock("@/app/actions/lesson", () => ({
  acknowledgeSlideAction: vi.fn(),
  askTopicChatAction: vi.fn(),
  continueAfterBlockAction: (...a: unknown[]) => continueAfterBlockAction(...a),
  explainStepAction: vi.fn().mockResolvedValue({ status: "error" }),
  getPreviousModuleAction: (...a: unknown[]) => getPreviousModuleAction(...a),
  goToPreviousStepAction: (...a: unknown[]) => goToPreviousStepAction(...a),
  pauseLessonAction: vi.fn().mockResolvedValue(undefined),
  setPresentationModeAction: vi.fn().mockResolvedValue(undefined),
  skipLessonBreakAction: vi.fn(),
  submitBlockFeedbackAction: vi.fn(),
  submitStepAnswerAction: (...a: unknown[]) => submitStepAnswerAction(...a),
  synthesizeNarrationAction: vi.fn(),
  takeLessonBreakAction: vi.fn(),
  tickLessonActivityAction: vi.fn().mockResolvedValue({ breakOffer: false }),
}));

const { LessonRunner } = await import("./LessonRunner");

interface TestStep {
  stepId: string;
  type: string;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  sourceRefs: { materialId: string; materialTitle: string; page: number | null }[];
  stepNumber: number;
  totalSteps: number;
}

const step: TestStep = {
  stepId: "step-1",
  type: "slide",
  content: { textUk: "Привіт" },
  visual: {},
  sourceRefs: [],
  stepNumber: 1,
  totalSteps: 3,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  getPreviousModuleAction.mockReset();
  goToPreviousStepAction.mockReset();
  continueAfterBlockAction.mockReset();
  submitStepAnswerAction.mockReset();
});

function renderRunner(currentBlockOrder?: number, activeStep: TestStep = step) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <LessonRunner
        sessionId="s1"
        subjectId="subj-1"
        topicId="top-1"
        step={activeStep}
        idleHintS={60}
        idlePauseS={180}
        presentationMode="text"
        currentBlockOrder={currentBlockOrder}
      />,
    );
  });
  return container;
}

function findButtonByText(root: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text) ?? null;
}

describe("BUG-029: «⬅️ Попередній модуль»", () => {
  it("is hidden on the first block (default currentBlockOrder)", () => {
    const el = renderRunner();
    expect(findButtonByText(el, "⬅️ Попередній модуль")).toBeNull();
  });

  it("shows a friendly message (not nothing) when the action resolves null", async () => {
    getPreviousModuleAction.mockResolvedValue(null);
    // A second block is required for the button to even be visible/clickable
    // (BUG-029 item 3): starts on block 2 directly.
    const el = renderRunner(2);
    const button = findButtonByText(el, "⬅️ Попередній модуль");
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPreviousModuleAction).toHaveBeenCalledWith("s1");
    // The old, buggy behaviour: nothing rendered at all for this state.
    expect(el.textContent).not.toBe("");
    expect(el.textContent).toContain("Це перший блок уроку — попереднього поки немає.");
    // No preview modal (that's the non-null branch) got rendered instead.
    expect(el.textContent).not.toContain("Попередній блок (перегляд)");
  });

  it("opens the read-only preview modal when the action resolves a view", async () => {
    getPreviousModuleAction.mockResolvedValue({ libraryItemId: "a", title: "Блок А", steps: [{ type: "slide", content: { textUk: "Текст А" } }] });
    const el = renderRunner(2);
    const button = findButtonByText(el, "⬅️ Попередній модуль")!;

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.textContent).toContain("Блок А");
    expect(el.textContent).not.toContain("Це перший блок уроку — попереднього поки немає.");
  });
});

/**
 * BUG-029 follow-up (PO): "⬅️ Попередній модуль" must be REAL navigation
 * within the active block, not only a read-only preview — «маю мати
 * можливість навігації в рамках уроку, а не вийти і почати спочатку».
 * These assert the actual step on screen changes (and stays an ordinary,
 * answerable step — the same "Далі" UI a slide step always has), not that a
 * read-only modal opened over it.
 */
describe("BUG-029 (PO follow-up): real step-back navigation, not just a preview", () => {
  const stepTwo = { stepId: "step-2", type: "slide", content: { textUk: "Другий крок" }, visual: {}, sourceRefs: [], stepNumber: 2, totalSteps: 3 };

  it("is visible from the block's 2nd step even on the lesson's very first block (currentBlockOrder omitted)", () => {
    const el = renderRunner(undefined, stepTwo);
    expect(findButtonByText(el, "⬅️ Попередній модуль")).not.toBeNull();
  });

  it("clicking it on the 2nd step calls goToPreviousStepAction and replaces the on-screen step with the 1st step it returns — not a modal", async () => {
    goToPreviousStepAction.mockResolvedValue({ stepId: "step-1", type: "slide", content: { textUk: "Перший крок (знову)" }, visual: {}, sourceRefs: [], stepNumber: 1, totalSteps: 3 });
    const el = renderRunner(undefined, stepTwo);
    expect(el.textContent).toContain("Другий крок");

    const button = findButtonByText(el, "⬅️ Попередній модуль")!;
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(goToPreviousStepAction).toHaveBeenCalledWith("s1");
    expect(getPreviousModuleAction).not.toHaveBeenCalled(); // the real move, not the read-only fallback
    // The 2nd step's own text is gone — the active step actually changed...
    expect(el.textContent).not.toContain("Другий крок");
    // ...to the 1st step's real content, rendered as the normal active step
    // (its own "Далі" button, same as any other slide step) rather than
    // inside `PreviousModuleModal`'s read-only card.
    expect(el.textContent).toContain("Перший крок (знову)");
    expect(el.textContent).not.toContain("Попередній блок (перегляд)");
    expect(findButtonByText(el, "Далі")).not.toBeNull();
  });
});

/**
 * BUG-031: "Далі" on the "Блок завершено!" screen (`BlockCompleteScreen`)
 * must actually advance the lesson — a real click, through the full
 * submit-answer -> block_complete -> continue chain, not a unit test of
 * `onContinue` in isolation (which would not have caught a real regression
 * in the wiring between them).
 */
describe("BUG-031: «Далі» on the block-complete screen actually advances the lesson", () => {
  const choiceStep = {
    stepId: "step-1",
    type: "choice",
    content: { questionUk: "2 + 2 = ?", options: [{ id: "a", textUk: "4" }] },
    visual: {},
    sourceRefs: [],
    stepNumber: 1,
    totalSteps: 1,
  };

  it("choosing the only answer reaches the block-complete screen, and clicking «Далі» starts the next block", async () => {
    submitStepAnswerAction.mockResolvedValue({
      verdict: "correct",
      explanation: "",
      formatChangeSuggested: false,
      next: { kind: "block_complete", libraryItemId: "item-1", visibleOutcomeUk: null },
    });
    const el = renderRunner(1, choiceStep);

    await act(async () => {
      findButtonByText(el, "4")!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submitStepAnswerAction).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Блок завершено!");
    const continueButton = findButtonByText(el, "Далі");
    expect(continueButton).not.toBeNull();

    // BUG-031's actual root cause: `continueAfterBlockAction` can take a
    // while (it may need to generate the next block on demand, per
    // `nextSessionBlock`/`generateOneBlock`) and the button gave NO visual
    // feedback at all while that was in flight — a real wait that looked,
    // from the child's side, exactly like "the button does nothing". A
    // deferred (not-yet-resolved) promise here reproduces that in-flight
    // window deterministically.
    let resolveContinue!: (v: unknown) => void;
    continueAfterBlockAction.mockReturnValue(new Promise((resolve) => (resolveContinue = resolve)));

    await act(async () => {
      continueButton!.click();
      await Promise.resolve();
    });

    expect(continueAfterBlockAction).toHaveBeenCalledWith("s1");
    // While still in flight: a busy label, not silence, and not clickable
    // again (no risk of firing a second, overlapping generation).
    expect(el.textContent).toContain("Готуємо наступний крок…");
    expect(findButtonByText(el, "Далі")).toBeNull();
    const busyButton = findButtonByText(el, "Готуємо наступний крок…")!;
    expect(busyButton.disabled).toBe(true);

    await act(async () => {
      resolveContinue({
        kind: "advance",
        step: { stepId: "step-2", type: "slide", content: { textUk: "Новий блок, крок 1" }, visual: {}, sourceRefs: [], stepNumber: 1, totalSteps: 2 },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The lesson actually moved on — the block-complete screen is gone and
    // the new block's first step is on screen, not a stuck "Блок завершено!".
    expect(el.textContent).not.toContain("Блок завершено!");
    expect(el.textContent).not.toContain("Готуємо наступний крок…");
    expect(el.textContent).toContain("Новий блок, крок 1");
  });
});
