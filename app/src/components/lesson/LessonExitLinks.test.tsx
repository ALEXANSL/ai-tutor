import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BUG-025: every state of the `/lesson/[sessionId]` screen — "choosing"
// (LessonPicker), "paused" (LessonPausedScreen) and the active step
// (LessonRunner) — must offer a way back to "Сьогодні" besides the
// browser's own back button. This is a render-snapshot test (no DOM
// events, matching this repo's existing client-component test style, e.g.
// `AiIntro.test.tsx`): it only asserts the `/today` link is present in the
// markup for all three states.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { LessonPicker } from "./LessonPicker";
import { LessonPausedScreen } from "./LessonPausedScreen";
import { LessonRunner } from "./LessonRunner";

const step = {
  stepId: "step-1",
  type: "slide",
  content: { textUk: "Привіт" },
  visual: {},
  sourceRefs: [],
  stepNumber: 1,
  totalSteps: 3,
};

describe("BUG-025: /today link present on every lesson screen state", () => {
  it("LessonPicker (mode: choosing)", () => {
    const html = renderToStaticMarkup(
      <LessonPicker sessionId="s1" candidates={[{ id: "c1", title: "Блок 1", estimatedMinutes: 10 }]} />,
    );
    expect(html).toContain('href="/today"');
  });

  it("LessonPausedScreen (status: paused)", () => {
    const html = renderToStaticMarkup(<LessonPausedScreen sessionId="s1" reason="manual_exit" />);
    expect(html).toContain('href="/today"');
  });

  it("LessonRunner (active step)", () => {
    const html = renderToStaticMarkup(
      <LessonRunner sessionId="s1" subjectId="subj-1" topicId="top-1" step={step} idleHintS={60} idlePauseS={180} />,
    );
    // BUG-020 already covers this state: "Вийти з уроку" pauses and sends
    // the child to "/today" (via `router.push`, not a plain `<a>`), so the
    // assertion here is on the button's presence, not on an `href`.
    expect(html).toContain("Вийти з уроку");
  });
});
