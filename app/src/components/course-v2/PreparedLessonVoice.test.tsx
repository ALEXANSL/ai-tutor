// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MathV2LessonView } from "@/server/lessons/mathCourseV2View";
import type { LiteratureV2LessonView } from "@/server/lessons/literatureV2View";
import type { VoiceTarget, VoiceTurn } from "@/lib/voice";

const calls = vi.hoisted(() => ({
  explain: vi.fn().mockResolvedValue({ status: "ok", content: "Пояснення для цього екрану" }),
  narrate: vi.fn().mockResolvedValue({ status: "unavailable" }),
  stop: vi.fn(),
}));
vi.mock("@/app/actions/math-course-v2", () => ({ explainMathCourseV2Action: calls.explain, narrateMathCourseV2Action: calls.narrate, revealExerciseSolutionAction: vi.fn(), submitQuestionAnswerAction: vi.fn() }));
vi.mock("@/app/actions/literature-course-v2", () => ({ explainLiteratureV2Action: calls.explain, narrateLiteratureV2Action: calls.narrate, revealLiteratureV2TaskHelpAction: vi.fn() }));
vi.mock("@/app/actions/lesson", () => ({ askTopicChatAction: vi.fn() }));
vi.mock("@/components/shared/MathText", () => ({ MathText: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock("@/components/shared/LessonNavBar", () => ({ LessonNavBar: () => null }));
vi.mock("@/components/shared/BookPageModal", () => ({ OpenTextbookPageButton: () => null }));
vi.mock("@/components/shared/VoiceModeControls", () => ({
  AutoAdvanceToggle: () => null, VoiceModeToggle: () => null,
  useVoiceModeControls: () => ({ voiceMode: false, autoAdvance: false, changeVoiceMode: vi.fn(), changeAutoAdvance: vi.fn() }),
}));
vi.mock("@/components/shared/StepNavBar", () => ({ STEP_NAV_BAR_SPACER_CLASS: "", StepNavBar: ({ onNext, nextDisabled }: { onNext: () => void; nextDisabled: boolean }) => <button data-next disabled={nextDisabled} onClick={onNext}>Наступний екран</button> }));
vi.mock("@/components/shared/singleAudioPlayback", () => ({ isCurrentlyPlaying: () => false, stopCurrentlyPlaying: calls.stop, playSingleAudio: vi.fn() }));
vi.mock("@/components/voice/VoiceConversation", () => ({
  VoiceConversation: ({ target, onTurn, onActiveChange }: { target: VoiceTarget; onTurn: (turn: VoiceTurn) => void; onActiveChange?: (active: boolean) => void }) => (
    <div data-voice-target={JSON.stringify(target)}>
      <button data-voice-start onClick={() => onActiveChange?.(true)}>Говорити</button>
      <button data-voice-turn onClick={() => onTurn({ text: "Чому саме так?", message: { id: "reply", author: "ai", content: "Розберімо це разом", createdAt: "now" }, audio: null })}>Тестова репліка</button>
    </div>
  ),
}));
const { MathCourseV2LessonScreen } = await import("./MathCourseV2LessonView");
const { LiteratureV2LessonScreen } = await import("./LiteratureV2LessonView");

const math: MathV2LessonView = {
  id: "lesson", subjectId: "math", topicId: "topic", packageId: "pkg", packageTitle: "Математика", lessonKey: "lesson", kind: "lesson", title: "Дроби", objectives: [],
  printedPageFrom: null, printedPageTo: null, textbookMaterialId: null, textbookTitle: null, textbookPageCount: null, status: "active", quizTitle: null, quizQuestions: [], exercises: [],
  screens: [1, 2].map((n) => ({ id: `screen-${n}`, order: n, role: "explanation", title: `Екран ${n}`, displayMd: `Дріб ${n}`, narration: `Дріб ${n}`, pauseAfter: false })),
};
const lit: LiteratureV2LessonView = {
  id: "lesson", subjectId: "literature", topicId: "topic", packageId: "pkg", packageTitle: "Література", lessonKey: "lesson", title: "Оповідання", estimatedMinutes: null,
  objectives: [], prerequisites: [], explanation: [], definitions: [], workedExample: null, tasks: [], printedPageFrom: null, printedPageTo: null, textbookMaterialId: null, textbookTitle: null, textbookPageCount: null, status: "active",
  screens: [1, 2].map((n) => ({ id: `screen-${n}`, order: n, stepType: "explanation", content: { display: `Історія ${n}`, tts: { text: `Історія ${n}`, lang: "uk" } }, tutorAction: "", assets: [] })),
};
let root: Root | null = null;
let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; calls.explain.mockClear(); calls.narrate.mockClear(); calls.stop.mockClear(); });

for (const variant of [
  { name: "prepared math", table: "course_v2_screens", element: () => <MathCourseV2LessonScreen lesson={math} packageLessons={[]} /> },
  { name: "prepared literature", table: "literature_v2_screens", element: () => <LiteratureV2LessonScreen lesson={lit} packageLessons={[]} /> },
]) {
  describe(`${variant.name} explanation voice integration`, () => {
    function mount() { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); act(() => root!.render(variant.element())); }
    function explainButton() { return [...container.querySelectorAll("button")].find((b) => b.textContent === "💡 Пояснити")!; }
    it("opens contextual voice after explanation and appends both transcript turns beside it", async () => {
      mount();
      expect(container.querySelector("[data-voice-target]")).toBeNull();
      await act(async () => explainButton().click());
      expect(container.textContent).toContain("Пояснення для цього екрану");
      expect(JSON.parse(container.querySelector("[data-voice-target]")!.getAttribute("data-voice-target")!)).toEqual({ kind: "course", refTable: variant.table, refId: "screen-1" });
      act(() => container.querySelector<HTMLButtonElement>("[data-voice-turn]")!.click());
      expect(container.textContent).toContain("Чому саме так?"); expect(container.textContent).toContain("Розберімо це разом");
      act(() => container.querySelector<HTMLButtonElement>("[data-voice-start]")!.click());
      expect(calls.stop).toHaveBeenCalled(); expect(explainButton().disabled).toBe(true);
    });
    it("unmounts the old voice and explanation when the lesson screen changes", async () => {
      mount(); await act(async () => explainButton().click());
      act(() => container.querySelector<HTMLButtonElement>("[data-next]")!.click());
      expect(container.querySelector("[data-voice-target]")).toBeNull();
      expect(container.textContent).not.toContain("Пояснення для цього екрану");
      await act(async () => explainButton().click());
      expect(JSON.parse(container.querySelector("[data-voice-target]")!.getAttribute("data-voice-target")!).refId).toBe("screen-2");
    });
  });
}
