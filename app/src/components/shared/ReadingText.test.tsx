// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ReadingText } from "./ReadingText";
it("reflows visually and can restore literal poem lines without altering any source words", async () => {
  const text = "М³фи       на вс³ часи\nРядок перший\nРядок другий";
  const host = document.createElement("div"); const root = createRoot(host);
  await act(async () => root.render(<ReadingText text={text} />));
  expect(host.querySelector(".lesson-prose--reflow")).not.toBeNull();
  expect(host.textContent).toContain("М³фи"); expect(host.textContent).toContain("помилки розпізнавання");
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === "Рядки оригіналу")!;
  await act(async () => button.click());
  expect(host.querySelector(".lesson-prose--reading")?.textContent).toBe(text);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  await act(async () => root.unmount());
});
