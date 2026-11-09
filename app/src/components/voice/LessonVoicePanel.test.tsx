// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VoiceTarget, VoiceTurn } from "@/lib/voice";
const f = vi.hoisted(() => ({ ask: vi.fn(), voice: null as null | { onTurn: (turn: VoiceTurn) => void; onActiveChange?: (active: boolean) => void } }));
vi.mock("@/app/actions/lesson", () => ({ askTopicChatAction: f.ask }));
vi.mock("./VoiceConversation", () => ({ VoiceConversation: (props: typeof f.voice) => { f.voice = props; return <button type="button" onClick={() => props?.onActiveChange?.(true)}>Поговорити голосом</button>; } }));
vi.mock("@/components/shared/MathText", () => ({ MathText: ({ text }: { text: string }) => <span>{text}</span> }));
import { LessonVoicePanel } from "./LessonVoicePanel";
let root: Root, container: HTMLDivElement;
const target: VoiceTarget = { kind: "chapter", lessonId: "lesson", stepId: "step1" };
const message = { id: "answer", author: "ai" as const, content: "Тема твору — пам’ять про батьківщину. Ідея — заклик берегти своє коріння.", createdAt: "2026-11-09" };
const question = "4. Сформулюй тему та ідею твору «Євшан-зілля».";
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); f.ask.mockReset().mockResolvedValue({ status: "ok", message }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function render(next = target, pages: number[] = []) { act(() => root.render(<LessonVoicePanel target={next} sourcePages={pages} textChat={{ subjectId: "literature", topicId: "topic" }} />)); }
function fill(text: string) { const input = container.querySelector("textarea")!; act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function send() { await act(async () => { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); }); }
it("shows a composer immediately and sends the exact textbook question with current chapter selectors", async () => {
  render(); fill(question); await send();
  expect(f.ask).toHaveBeenCalledWith(null, "literature", "topic", question, target);
  expect(container.textContent).toContain(message.content);
  expect(container.querySelector("textarea")?.value).toBe("");
});
it("combines voice and text turns, preserves them between modules and uses the new module target", async () => {
  render(); fill(question); await send();
  act(() => f.voice?.onTurn({ text: "А хто автор?", message: { ...message, id: "voice-answer", content: "Микола Вороний." }, audio: null }));
  render({ ...target, stepId: "step2" });
  expect(container.textContent).toContain(message.content);
  expect(container.textContent).toContain("Микола Вороний.");
  f.ask.mockResolvedValue({ status: "ok", message: { ...message, id: "answer2" } });
  fill("Поясни ідею простіше"); await send();
  expect(f.ask).toHaveBeenLastCalledWith(null, "literature", "topic", "Поясни ідею простіше", { ...target, stepId: "step2" });
  render({ ...target, lessonId: "another-lesson" });
  expect(container.textContent).not.toContain("Микола Вороний.");
});
it("retains a failed question and prevents concurrent voice/text requests", async () => {
  f.ask.mockResolvedValueOnce({ status: "error" });
  render(); fill(question); await send();
  expect(container.querySelector("textarea")?.value).toBe(question);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  act(() => f.voice?.onActiveChange?.(true));
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  act(() => f.voice?.onActiveChange?.(false));
  await send(); expect(container.textContent).toContain(message.content);
});
it("locks duplicate submissions while waiting for the reply", async () => {
  let finish!: (value: unknown) => void;
  f.ask.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(); fill(question);
  await act(async () => { const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!; button.click(); button.click(); });
  expect(f.ask).toHaveBeenCalledOnce();
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  await act(async () => finish({ status: "ok", message }));
  expect(container.querySelector("fieldset")?.disabled).toBe(false);
});
it("accepts a whole page and adds a quoted selection without truncating it", async () => {
  render();
  const page = "Поясни уривок. ".repeat(900);
  fill(page);
  expect(container.querySelector("textarea")?.maxLength).toBe(20_000);
  vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Окремо виділений уривок твору." } as Selection);
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Додати виділений уривок")!.click(); });
  await send();
  expect(f.ask.mock.calls[0]?.[3]).toContain(page.trim());
  expect(f.ask.mock.calls[0]?.[3]).toContain("Окремо виділений уривок твору.");
});
it("attaches at most two printed page selectors and keeps them on an API failure", async () => {
  f.ask.mockResolvedValue({ status: "error", message: "Сторінка недоступна" });
  render(target, [10, 20, 30]);
  for (const value of [10, 20]) {
    act(() => { const select = container.querySelector("select")!; select.value = String(value); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Додати сторінку")!.click(); });
  }
  expect(container.querySelector("select")?.disabled).toBe(true);
  fill(question); await send();
  expect(f.ask).toHaveBeenCalledWith(null, "literature", "topic", question, target, { printedPages: [10, 20] });
  expect(container.querySelector("textarea")?.value).toBe(question);
  expect(container.textContent).toContain("Сторінка недоступна");
});
