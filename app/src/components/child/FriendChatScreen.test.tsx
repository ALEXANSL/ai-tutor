// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  archiveFriendChatAction: vi.fn(),
  askFriendChatAction: vi.fn(),
  clearFriendChatAction: vi.fn(),
  createFriendChatAction: vi.fn(),
  listFriendChatsAction: vi.fn(),
  loadFriendChatAction: vi.fn(),
  renameFriendChatAction: vi.fn(),
}));
vi.mock("@/app/actions/friend", () => actions);
vi.mock("@/components/voice/VoiceConversation", () => ({
  VoiceConversation: ({ onActiveChange }: { onActiveChange: (value: boolean) => void }) => (
    <button type="button" onClick={() => onActiveChange(true)}>Test voice start</button>
  ),
}));

import { FriendChatScreen } from "./FriendChatScreen";

const chats = [
  { id: "chat-1", title: "Дракони", createdAt: "2026-10-21T09:00:00Z", updatedAt: "2026-10-21T09:00:00Z" },
  { id: "chat-2", title: "Космос", createdAt: "2026-10-21T08:00:00Z", updatedAt: "2026-10-21T08:00:00Z" },
];
const initialMessages = [
  { id: "message-1", author: "ai" as const, content: "Привіт із розмови про драконів", createdAt: "2026-10-21T09:00:00Z" },
];
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
  actions.listFriendChatsAction.mockResolvedValue(chats);
  actions.renameFriendChatAction.mockResolvedValue(undefined);
  actions.clearFriendChatAction.mockResolvedValue(undefined);
  actions.archiveFriendChatAction.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<FriendChatScreen initialChatId="chat-1" initialChats={chats} initialMessages={initialMessages} />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
async function click(text: string) { await act(async () => { button(text).click(); }); }
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function log() { return container.querySelector('[role="log"]')!; }

describe("FriendChatScreen conversations", () => {
  it("creates a separate empty conversation without carrying the previous transcript", async () => {
    actions.createFriendChatAction.mockResolvedValue({ id: "chat-new", title: "Нова розмова", createdAt: "now", updatedAt: "now" });
    await click("+ Нова розмова");
    expect(actions.createFriendChatAction).toHaveBeenCalledOnce();
    expect(container.querySelector("h2")!.textContent).toBe("Нова розмова");
    expect(log().textContent).not.toContain(initialMessages[0]!.content);
    expect(container.querySelector("select")!.value).toBe("chat-new");
  });

  it("loads only the selected conversation, retaining the current view if loading fails", async () => {
    actions.loadFriendChatAction.mockRejectedValueOnce(new Error("network"));
    await click("Космос");
    expect(actions.loadFriendChatAction).toHaveBeenCalledWith("chat-2");
    expect(container.querySelector("h2")!.textContent).toBe("Дракони");
    expect(log().textContent).toContain(initialMessages[0]!.content);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Не вдалося відкрити");
    actions.loadFriendChatAction.mockResolvedValueOnce({ chatId: "chat-2", messages: [{ ...initialMessages[0], id: "space-answer", content: "Про сузір’я" }] });
    await click("Космос");
    expect(log().textContent).toContain("Про сузір’я");
    expect(log().textContent).not.toContain(initialMessages[0]!.content);
  });

  it("keeps unsent drafts separate when switching conversations", async () => {
    input(container.querySelector("textarea")!, "Питання про драконів, яке ще дописую");
    actions.loadFriendChatAction.mockResolvedValueOnce({ chatId: "chat-2", messages: [] });
    await click("Космос");
    expect(container.querySelector("textarea")!.value).toBe("");
    input(container.querySelector("textarea")!, "Питання про зорі");
    actions.loadFriendChatAction.mockResolvedValueOnce({ chatId: "chat-1", messages: initialMessages });
    await click("Дракони");
    expect(container.querySelector("textarea")!.value).toBe("Питання про драконів, яке ще дописую");
  });

  it("explains parent retention, and clears the visible conversation only after successful confirmation", async () => {
    await click("Очистити чат");
    expect(actions.clearFriendChatAction).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain("Тато зможе переглянути попередню історію");
    actions.clearFriendChatAction.mockRejectedValueOnce(new Error("network"));
    await click("Так, продовжити");
    expect(log().textContent).toContain(initialMessages[0]!.content);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await click("Так, продовжити");
    expect(actions.clearFriendChatAction).toHaveBeenLastCalledWith("chat-1");
    expect(log().textContent).not.toContain(initialMessages[0]!.content);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("keeps a failed message as an editable draft and rolls back its optimistic bubble", async () => {
    actions.askFriendChatAction.mockRejectedValueOnce(new Error("network"));
    actions.loadFriendChatAction.mockResolvedValueOnce({ chatId: "chat-1", messages: initialMessages });
    input(container.querySelector("textarea")!, "Розкажи про драконів");
    await click("Надіслати");
    expect(actions.askFriendChatAction).toHaveBeenCalledWith("Розкажи про драконів", "chat-1");
    expect(container.querySelector("textarea")!.value).toBe("Розкажи про драконів");
    expect(log().textContent).not.toContain("Розкажи про драконів");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Твій текст залишився");
  });

  it("prevents thread changes during a pending reply and leaves that reply in its original thread", async () => {
    let resolve!: (value: unknown) => void;
    actions.askFriendChatAction.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    input(container.querySelector("textarea")!, "А де живуть дракони?");
    await click("Надіслати");
    expect(button("Космос").disabled).toBe(true);
    expect(button("+ Нова розмова").disabled).toBe(true);
    expect(button("Очистити чат").disabled).toBe(true);
    await click("Космос");
    expect(actions.loadFriendChatAction).not.toHaveBeenCalled();
    await act(async () => { resolve({ status: "ok", message: { ...initialMessages[0], id: "new-answer", content: "У казкових горах" } }); });
    expect(container.querySelector("h2")!.textContent).toBe("Дракони");
    expect(log().textContent).toContain("У казкових горах");
    expect(button("Космос").disabled).toBe(false);
  });

  it("renames a conversation inline and archives it without deleting the remaining chats", async () => {
    await click("Перейменувати");
    input(container.querySelector('input[maxlength="60"]')!, "Казкові істоти");
    await click("Зберегти");
    expect(actions.renameFriendChatAction).toHaveBeenCalledWith("chat-1", "Казкові істоти");
    expect(container.querySelector("h2")!.textContent).toBe("Казкові істоти");
    actions.loadFriendChatAction.mockResolvedValueOnce({ chatId: "chat-2", messages: [] });
    await click("Прибрати чат");
    expect(container.querySelector('[role="alertdialog"]')!.textContent).toContain("історія залишиться доступною татові");
    await click("Так, продовжити");
    expect(actions.archiveFriendChatAction).toHaveBeenCalledWith("chat-1");
    expect(container.querySelector("h2")!.textContent).toBe("Космос");
    expect([...container.querySelectorAll("option")].map((option) => option.value)).toEqual(["chat-2"]);
  });

  it("locks text and thread controls for an active voice conversation", async () => {
    await click("Test voice start");
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    expect(button("+ Нова розмова").disabled).toBe(true);
    expect(button("Очистити чат").disabled).toBe(true);
    expect(button("Космос").disabled).toBe(true);
  });
});
