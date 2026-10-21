// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopCurrentlyPlaying } from "@/components/shared/singleAudioPlayback";

const actions = vi.hoisted(() => ({ math: vi.fn(), literature: vi.fn(), literatureV3: vi.fn(), explainMath: vi.fn(), explainLiterature: vi.fn(), ask: vi.fn() }));
vi.mock("@/app/actions/math-course-v2", () => ({ narrateMathCourseV2Action: actions.math, explainMathCourseV2Action: actions.explainMath, revealExerciseSolutionAction: vi.fn() }));
vi.mock("@/app/actions/literature-course-v2", () => ({ narrateLiteratureV2Action: actions.literature, explainLiteratureV2Action: actions.explainLiterature, revealLiteratureV2TaskHelpAction: vi.fn() }));
vi.mock("@/app/actions/literature-v3", () => ({ narrateLiteratureV3Action: actions.literatureV3, saveReadingPositionAction: vi.fn() }));
vi.mock("@/app/actions/lesson", () => ({ askTopicChatAction: actions.ask }));
vi.mock("@/components/shared/LessonNavBar", () => ({ LessonNavBar: () => null }));
vi.mock("@/components/shared/BookPageModal", () => ({ OpenTextbookPageButton: () => null }));
vi.mock("@/components/child/OpenVirtualBookButton", () => ({ OpenVirtualBookButton: () => null }));
vi.mock("@/components/course-v2/QuestionCard", () => ({ QuestionCard: () => null }));
vi.mock("@/components/shared/MathText", () => ({ MathText: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock("@/components/shared/VoiceModeControls", () => ({
  useVoiceModeControls: () => ({ voiceMode: false, autoAdvance: false, changeVoiceMode: vi.fn(), changeAutoAdvance: vi.fn() }),
  VoiceModeToggle: () => null, AutoAdvanceToggle: () => null,
}));

import { MathCourseV2LessonScreen } from "./MathCourseV2LessonView";
import { LiteratureV2LessonScreen } from "./LiteratureV2LessonView";
import { LiteratureV3LessonScreen } from "./LiteratureV3LessonView";

class MockAudio extends EventTarget {
  pause = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
  constructor(public src: string) { super(); audios.push(this); }
}
const audios: MockAudio[] = [];
const speech = { status: "ok", audioMime: "audio/mpeg", audioBase64: "AAAA" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Kind = "math" | "literature" | "literatureV3";
let root: Root | null;
let container: HTMLDivElement;
beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.ask.mockResolvedValue({ status: "ok", message: { content: "Пояснення" } });
  actions.math.mockResolvedValue(speech);
  actions.literature.mockResolvedValue(speech);
  actions.literatureV3.mockResolvedValue(speech);
  actions.explainMath.mockResolvedValue({ status: "ok", content: "Додаткове пояснення" });
  actions.explainLiterature.mockResolvedValue({ status: "ok", content: "Додаткове пояснення" });
  stopCurrentlyPlaying();
  audios.length = 0;
  vi.stubGlobal("Audio", MockAudio);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  stopCurrentlyPlaying();
  container.remove();
  vi.unstubAllGlobals();
});
function render(kind: Kind) {
  const common = { id: "lesson", subjectId: "subject", topicId: "topic", title: "Урок", packageTitle: "Підручник", objectives: [], kind: "lesson", status: "ready", exercises: [], quizQuestions: [], definitions: [], tasks: [] };
  if (kind === "math") {
    const lesson = { ...common, screens: [1, 2].map((id) => ({ id: `step-${id}`, title: `Крок ${id}`, displayMd: `Текст ${id}`, narration: `Озвучка ${id}` })) };
    act(() => root!.render(<MathCourseV2LessonScreen lesson={lesson as unknown as ComponentProps<typeof MathCourseV2LessonScreen>["lesson"]} packageLessons={[]} />));
  } else if (kind === "literature") {
    const lesson = { ...common, screens: [1, 2].map((id) => ({ id: `step-${id}`, assets: [], content: { display: `Текст ${id}`, tts: { text: `Озвучка ${id}` } } })) };
    act(() => root!.render(<LiteratureV2LessonScreen lesson={lesson as unknown as ComponentProps<typeof LiteratureV2LessonScreen>["lesson"]} packageLessons={[]} />));
  } else {
    const lesson = { ...common, flow: [1, 2].map((id) => ({ id: `step-${id}`, kind: "screen", title: `Крок ${id}`, displayText: `Текст ${id}`, illustrations: [], ttsText: `Озвучка ${id}` })) };
    act(() => root!.render(<LiteratureV3LessonScreen lesson={lesson as unknown as ComponentProps<typeof LiteratureV3LessonScreen>["lesson"]} packageLessons={[]} bookIndex={[]} savedPosition={null} />));
  }
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Missing ${text}`);
  await act(async () => { button.click(); });
}

describe.each<Kind>(["math", "literature", "literatureV3"])("%s lesson narration", (kind) => {
  it("stops active audio on the next screen", async () => {
    render(kind);
    await click("🔊 Слухати");
    expect(audios).toHaveLength(1);
    await click("Далі →");
    expect(audios[0]!.pause).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Текст 2");
  });

  it("never plays a previous screen's pending narration after moving forward", async () => {
    const pending = deferred<typeof speech>();
    actions[kind].mockReturnValueOnce(pending.promise);
    render(kind);
    await click("🔊 Слухати");
    await click("Далі →");
    await act(async () => { pending.resolve(speech); });
    expect(audios).toHaveLength(0);
    await click("🔊 Слухати");
    expect(actions[kind]).toHaveBeenLastCalledWith(expect.objectContaining({ refId: "step-2" }));
    expect(audios).toHaveLength(1);
  });

  it("never plays pending narration after leaving the lesson", async () => {
    const pending = deferred<typeof speech>();
    actions[kind].mockReturnValueOnce(pending.promise);
    render(kind);
    await click("🔊 Слухати");
    act(() => { root!.unmount(); root = null; });
    await act(async () => { pending.resolve(speech); });
    expect(audios).toHaveLength(0);
  });
});

describe.each<"math" | "literature">(["math", "literature"])("%s explanation narration", (kind) => {
  it("drops explanation TTS that finishes after moving to another screen", async () => {
    const pending = deferred<typeof speech>();
    actions[kind].mockReturnValueOnce(pending.promise);
    render(kind);
    await click("💡 Пояснити");
    expect(container.textContent).toContain("Додаткове пояснення");
    await click("Далі →");
    await act(async () => { pending.resolve(speech); });
    expect(audios).toHaveLength(0);
    expect(container.textContent).not.toContain("Додаткове пояснення");
  });

  it("does not request paid TTS when the text explanation itself returns after unmount", async () => {
    const pending = deferred<{ status: string; content: string }>();
    (kind === "math" ? actions.explainMath : actions.explainLiterature).mockReturnValueOnce(pending.promise);
    render(kind);
    await click("💡 Пояснити");
    act(() => { root!.unmount(); root = null; });
    await act(async () => { pending.resolve({ status: "ok", content: "Запізніле пояснення" }); });
    expect(actions[kind]).not.toHaveBeenCalled();
    expect(audios).toHaveLength(0);
  });
});


describe.each<"math" | "literature">(["math", "literature"])("%s text lesson context", kind => {
  it("sends the actual current screen selector after navigation", async () => {
    render(kind);
    await click("Далі →");
    await click("💬 Запитати репетитора про цю тему");
    const input = container.querySelector<HTMLInputElement>("input[placeholder^='Поясни']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Поясни це");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Надіслати");
    expect(actions.ask).toHaveBeenCalledWith(null, "subject", "topic", "Поясни це", {
      kind: "course", refTable: kind === "math" ? "course_v2_screens" : "literature_v2_screens", refId: "step-2",
    });
  });
});
