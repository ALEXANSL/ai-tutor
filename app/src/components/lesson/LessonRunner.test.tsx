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
const continueAfterBlockAction = vi.fn();
vi.mock("@/app/actions/lesson", () => ({
  acknowledgeSlideAction: vi.fn(),
  askTopicChatAction: vi.fn(),
  continueAfterBlockAction: (...a: unknown[]) => continueAfterBlockAction(...a),
  explainStepAction: vi.fn().mockResolvedValue({ status: "error" }),
  getPreviousModuleAction: (...a: unknown[]) => getPreviousModuleAction(...a),
  pauseLessonAction: vi.fn().mockResolvedValue(undefined),
  setPresentationModeAction: vi.fn().mockResolvedValue(undefined),
  skipLessonBreakAction: vi.fn(),
  submitBlockFeedbackAction: vi.fn(),
  submitStepAnswerAction: vi.fn(),
  synthesizeNarrationAction: vi.fn(),
  takeLessonBreakAction: vi.fn(),
  tickLessonActivityAction: vi.fn().mockResolvedValue({ breakOffer: false }),
}));

const { LessonRunner } = await import("./LessonRunner");

const step = {
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
  continueAfterBlockAction.mockReset();
});

function renderRunner(currentBlockOrder?: number) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <LessonRunner
        sessionId="s1"
        subjectId="subj-1"
        topicId="top-1"
        step={step}
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
