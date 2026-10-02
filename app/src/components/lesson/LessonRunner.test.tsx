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
const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: (...a: unknown[]) => routerPush(...a), replace: () => {} }),
}));

const getPreviousModuleAction = vi.fn();
const goToPreviousStepAction = vi.fn();
const continueAfterBlockAction = vi.fn();
const submitStepAnswerAction = vi.fn();
const pauseLessonAction = vi.fn().mockResolvedValue(undefined);
const synthesizeNarrationAction = vi.fn();
vi.mock("@/app/actions/lesson", () => ({
  acknowledgeSlideAction: vi.fn(),
  askTopicChatAction: vi.fn(),
  continueAfterBlockAction: (...a: unknown[]) => continueAfterBlockAction(...a),
  explainStepAction: vi.fn().mockResolvedValue({ status: "error" }),
  getPreviousModuleAction: (...a: unknown[]) => getPreviousModuleAction(...a),
  goToPreviousStepAction: (...a: unknown[]) => goToPreviousStepAction(...a),
  pauseLessonAction: (...a: unknown[]) => pauseLessonAction(...a),
  prefetchNextStepNarrationAction: vi.fn().mockResolvedValue(undefined),
  setPresentationModeAction: vi.fn().mockResolvedValue(undefined),
  skipLessonBreakAction: vi.fn(),
  submitBlockFeedbackAction: vi.fn(),
  submitStepAnswerAction: (...a: unknown[]) => submitStepAnswerAction(...a),
  synthesizeNarrationAction: (...a: unknown[]) => synthesizeNarrationAction(...a),
  takeLessonBreakAction: vi.fn(),
  tickLessonActivityAction: vi.fn().mockResolvedValue({ breakOffer: false }),
}));

const { LessonRunner } = await import("./LessonRunner");

interface TestStep {
  stepId: string;
  type: string;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  sourceRefs: { materialId: string; materialTitle: string; page: number | null; sectionTitle?: string | null }[];
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
  pauseLessonAction.mockClear();
  pauseLessonAction.mockResolvedValue(undefined);
  synthesizeNarrationAction.mockReset();
  routerPush.mockClear();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

function renderRunner(currentBlockOrder?: number, activeStep: TestStep = step, presentationMode: "text" | "voice" | "auto" = "text") {
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
        presentationMode={presentationMode}
        currentBlockOrder={currentBlockOrder}
      />,
    );
  });
  return container;
}

function findButtonByText(root: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text) ?? null;
}

/**
 * D-106 (PO decision 2026-09-28): the source citation under a step must show
 * the textbook's section/topic title alongside the page, when the cited
 * page falls within one — not only "стор. N" as before.
 */
describe("D-106: source citation shows the section/topic title next to the page", () => {
  it("shows the section title when the citation carries one", () => {
    const withSection: TestStep = {
      ...step,
      sourceRefs: [{ materialId: "mat1", materialTitle: "Математика, підручник", page: 42, sectionTitle: "Дроби" }],
    };
    const el = renderRunner(undefined, withSection);
    expect(el.textContent).toContain("Математика, підручник, розд. «Дроби», стор. 42");
  });

  it("falls back to page-only when the page falls outside every indexed section (no sectionTitle)", () => {
    const noSection: TestStep = {
      ...step,
      sourceRefs: [{ materialId: "mat1", materialTitle: "Математика, підручник", page: 42, sectionTitle: null }],
    };
    const el = renderRunner(undefined, noSection);
    expect(el.textContent).toContain("Математика, підручник, стор. 42");
    expect(el.textContent).not.toContain("розд.");
  });
});

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

/**
 * BUG-034: the block-complete screen used to have exactly one control —
 * "Далі" — which went `disabled` while `continueAfterBlockAction` was
 * in flight (BUG-031), leaving no way off the screen at all for the 1-5
 * minutes a real on-demand generation can take. "Вийти з уроку" must be
 * present and clickable the whole time, and must navigate away WITHOUT
 * waiting for that in-flight promise to ever resolve.
 */
describe("BUG-034: «Вийти з уроку» on the block-complete screen always works, even mid-generation", () => {
  const choiceStep = {
    stepId: "step-1",
    type: "choice",
    content: { questionUk: "2 + 2 = ?", options: [{ id: "a", textUk: "4" }] },
    visual: {},
    sourceRefs: [],
    stepNumber: 1,
    totalSteps: 1,
  };

  it("stays clickable and navigates to /today while «Далі» is still busy/disabled", async () => {
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

    expect(el.textContent).toContain("Блок завершено!");

    // A deferred, never-resolved-in-this-test promise reproduces the real
    // multi-minute on-demand generation deterministically.
    continueAfterBlockAction.mockReturnValue(new Promise(() => {}));
    const continueButton = findButtonByText(el, "Далі")!;
    await act(async () => {
      continueButton.click();
      await Promise.resolve();
    });

    // "Далі" is now busy/disabled (BUG-031) — the exit link must still be
    // there and enabled regardless.
    expect(findButtonByText(el, "Далі")).toBeNull();
    const exitButton = findButtonByText(el, "Вийти з уроку");
    expect(exitButton).not.toBeNull();
    expect(exitButton!.disabled).toBe(false);

    await act(async () => {
      exitButton!.click();
      // Deliberately not awaiting/resolving `continueAfterBlockAction`'s
      // promise at all — the exit must not wait on it.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pauseLessonAction).toHaveBeenCalledWith("s1", "manual_exit");
    expect(routerPush).toHaveBeenCalledWith("/today");
  });
});

/**
 * D-111 п.5 (PO decision 2026-09-28): narration audio is generated ~10%
 * faster server-side (`openaiTts`'s `speed: 1.1`), and the player also lets
 * the listener pick their own extra playback-rate multiplier — "як у
 * більшості курсів" (podcast/audiobook-style speed buttons), independent of
 * that generation-time speed.
 */
describe("D-111 п.5: narration playback-speed control", () => {
  it("defaults to 1x, and choosing a speed sets playbackRate and remembers it for the next step", async () => {
    synthesizeNarrationAction.mockResolvedValue({ status: "ok", mimeType: "audio/mpeg", audioBase64: "AAAA" });
    const el = renderRunner(undefined, step, "voice");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const audio = el.querySelector("audio") as HTMLAudioElement;
    expect(audio).not.toBeNull();
    expect(audio.playbackRate).toBe(1);

    const fastButton = findButtonByText(el, "1.5×")!;
    expect(fastButton).not.toBeNull();

    await act(async () => {
      fastButton.click();
    });

    expect(audio.playbackRate).toBe(1.5);
    expect(fastButton.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("narrationSpeed")).toBe("1.5");
  });

  it("carries the previously chosen speed into a freshly mounted player (next step)", async () => {
    window.localStorage.setItem("narrationSpeed", "0.75");
    synthesizeNarrationAction.mockResolvedValue({ status: "ok", mimeType: "audio/mpeg", audioBase64: "AAAA" });
    const el = renderRunner(undefined, step, "voice");

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const audio = el.querySelector("audio") as HTMLAudioElement;
    expect(audio.playbackRate).toBe(0.75);
    expect(findButtonByText(el, "0.75×")!.getAttribute("aria-pressed")).toBe("true");
  });
});
