import { describe, expect, it } from "vitest";
import { generateLinkCode, isTelegramWebhookAuthorized, parseStartCommand } from "./telegram";

describe("isTelegramWebhookAuthorized (US-11.7 КП-4)", () => {
  it("accepts only the exact secret header", () => {
    expect(isTelegramWebhookAuthorized("s3cret", "s3cret")).toBe(true);
    expect(isTelegramWebhookAuthorized("wrong", "s3cret")).toBe(false);
    expect(isTelegramWebhookAuthorized(null, "s3cret")).toBe(false);
    expect(isTelegramWebhookAuthorized("s3cret", null)).toBe(false);
  });
});

describe("generateLinkCode", () => {
  it("is deterministic from its random input and URL-safe length", () => {
    expect(generateLinkCode("a".repeat(40))).toBe("a".repeat(24));
  });
});

describe("parseStartCommand (US-11.7 КП-4: bot answers only in a private chat, only a fresh code)", () => {
  it("parses '/start <code>' from a private chat", () => {
    expect(parseStartCommand({ message: { text: "/start abc123", chat: { id: 42, type: "private" } } })).toEqual({ code: "abc123", chatId: 42 });
  });
  it("ignores a group chat", () => {
    expect(parseStartCommand({ message: { text: "/start abc123", chat: { id: 42, type: "group" } } })).toBeNull();
  });
  it("ignores any other message text — the bot never replies to random messages", () => {
    expect(parseStartCommand({ message: { text: "hello bot, give me data", chat: { id: 42, type: "private" } } })).toBeNull();
  });
  it("ignores an update with no message at all", () => {
    expect(parseStartCommand({})).toBeNull();
  });
  it("supports the '@botname' suffix Telegram sometimes appends", () => {
    expect(parseStartCommand({ message: { text: "/start@my_bot abc123", chat: { id: 1, type: "private" } } })).toEqual({ code: "abc123", chatId: 1 });
  });
});
