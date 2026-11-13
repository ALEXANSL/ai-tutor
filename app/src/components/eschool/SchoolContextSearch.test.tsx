// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ action: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: f.refresh }) }));
vi.mock("@/app/actions/eschool", () => ({ resolveSchoolContextAction: f.action }));
import { SchoolContextSearch } from "./SchoolContextSearch";
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("shows progress, refreshes after a match and ignores the discarded StrictMode response", async () => {
  let resolve!: (value: object) => void;
  const promise = new Promise(r => { resolve = r; }); f.action.mockReturnValue(promise);
  act(() => root.render(<StrictMode><SchoolContextSearch entryId="entry" subjectId="subject" /></StrictMode>));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("ШІ порівнює");
  await act(async () => { resolve({ status: "ok", topicId: "topic", state: "done" }); await promise; });
  expect(f.refresh).toHaveBeenCalledTimes(1);
});
it("shows a cached uncertainty without another action and keeps guidance visible", () => {
  act(() => root.render(<SchoolContextSearch entryId="entry" subjectId="subject" initial={{ state: "done", reason: "Тема охоплює два уроки" }} />));
  expect(container.textContent).toContain("два уроки"); expect(container.textContent).toContain("Обери потрібний урок"); expect(f.action).not.toHaveBeenCalled();
});
it("ends progress with a useful message if the action fails", async () => {
  f.action.mockResolvedValue({ status: "error", message: "Недоступний предмет" });
  await act(async () => { root.render(<SchoolContextSearch entryId="entry" subjectId="subject" />); });
  expect(container.textContent).toContain("Недоступний предмет"); expect(container.textContent).not.toContain("ШІ порівнює");
});
