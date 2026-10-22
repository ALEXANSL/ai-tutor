// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceTurn } from "@/lib/voice";
import { FriendChatScreen } from "./FriendChatScreen";

const askFriendChatAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/friend", () => ({ askFriendChatAction }));

// `VoiceConversation` has its own thorough test suite (microphone/session
// lifecycle) — here only the INTEGRATION matters: does a turn it reports
// land in this screen's own message thread, in the right order.
const capturedOnTurn = vi.hoisted(() => ({ fn: null as ((turn: VoiceTurn) => void) | null }));
vi.mock("@/components/voice/VoiceConversation", () => ({
  VoiceConversation: (props: { onTurn: (turn: VoiceTurn) => void }) => {
    capturedOnTurn.fn = props.onTurn;
    return null;
  },
}));

let container: HTMLDivElement;
let root: Root | null;
beforeEach(() => {
  askFriendChatAction.mockReset();
  capturedOnTurn.fn = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function render() {
  act(() => root!.render(<FriendChatScreen initialMessages={[]} />));
}

describe("FriendChatScreen", () => {
  it("shows a visible exit button back to Сьогодні, not just browser back", () => {
    render();
    const back = [...container.querySelectorAll("a")].find((a) => a.textContent === "← Сьогодні");
    expect(back).toBeDefined();
    expect(back?.getAttribute("href")).toBe("/today");
  });

  it("sends a typed message and appends the reply", async () => {
    askFriendChatAction.mockResolvedValue({ status: "ok", message: { id: "reply-1", author: "ai", content: "Привіт!", createdAt: "2026-10-22T00:00:00Z" } });
    render();
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Привіт");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...container.querySelectorAll("button")].find((b) => b.textContent === "Надіслати")!;
    await act(async () => { send.click(); });
    expect(askFriendChatAction).toHaveBeenCalledWith("Привіт");
    expect(container.textContent).toContain("Привіт!");
  });

  it("appends a voice turn (both the recognized speech and the reply) to the same thread", async () => {
    render();
    expect(capturedOnTurn.fn).toBeTypeOf("function");
    const turn: VoiceTurn = {
      text: "Чому небо синє?",
      message: { id: "voice-reply-1", author: "ai", content: "Через розсіювання світла.", createdAt: "2026-10-22T00:00:00Z" },
      audio: null,
    };
    await act(async () => { capturedOnTurn.fn!(turn); });
    expect(container.textContent).toContain("Чому небо синє?");
    expect(container.textContent).toContain("Через розсіювання світла.");
  });
});
