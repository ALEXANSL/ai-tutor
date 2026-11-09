import { expect, it } from "vitest";
import { lessonChatHistory, MAX_LESSON_QUESTION_CHARS } from "./lesson-chat";
it("allows a full page and does not duplicate the current long question in model history", () => {
  const page = "Навчальний текст. ".repeat(700);
  expect(page.length).toBeLessThan(MAX_LESSON_QUESTION_CHARS);
  const history = lessonChatHistory([{ author: "child", content: page }, { author: "ai", content: "Попередня відповідь" }], page);
  expect(history).not.toContain(page); expect(history).toContain("Попередня відповідь");
});
it("bounds accumulated history without modifying current user input", () => {
  const current = "x".repeat(20_000);
  const history = lessonChatHistory(Array.from({ length: 20 }, () => ({ author: "child", content: "old".repeat(7000) })), current);
  expect(history.length).toBeLessThan(24_100); expect(history).toContain("скорочено"); expect(current).toHaveLength(20_000);
});
