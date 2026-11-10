// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContentWorkspace } from "./ContentWorkspace";
import { markBusyEnd, markBusyStart } from "@/lib/busy-signal";
it("separates intents, preserves unsent state and refuses switching during an active upload", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    act(() => root.render(<ContentWorkspace>{{ course: <input aria-label="Чернетка" defaultValue="" />, video: <p>Відеоформа</p>, book: <p>Книга</p>, materials: <p>Додаткове</p> }}</ContentWorkspace>));
    const input = container.querySelector("input")!; input.value = "Архів обрано";
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    act(() => tabs[1]!.click()); expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    act(() => tabs[0]!.click()); expect(container.querySelector("input")?.value).toBe("Архів обрано");
    markBusyStart(); act(() => tabs[2]!.click());
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true"); expect(container.textContent).toContain("Зачекай завершення");
    markBusyEnd();
    act(() => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(tabs[3]!.getAttribute("aria-selected")).toBe("true"); expect(document.activeElement).toBe(tabs[3]);
  } finally { markBusyEnd(); act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
