// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VideoDraft } from "@/lib/video-script";
const generate = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/video-script", () => ({ generateVideoScriptAction: generate }));
import { VideoScriptEditor } from "./VideoScriptEditor";
const draft: VideoDraft = { version: 1, title: "Історія", provider: "openai", model: "test", minutes: 5, sourceHash: "a".repeat(64), createdAt: "2026-11-09", scenes: [1, 2].map(n => ({ title: `Сцена ${n}`, narration: `Озвучення ${n}.`, visualPrompt: `Scene ${n}`, sourceBlockIds: ["b1"] })) };
let root: Root, container: HTMLDivElement;
beforeEach(() => { generate.mockReset(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function render(initialDraft: VideoDraft | null = null, sourceHash = draft.sourceHash) { act(() => root.render(<VideoScriptEditor subjectId="subject" topicId="topic" sourceHash={sourceHash} initialDraft={initialDraft} />)); }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === text);
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}
it("opens a saved draft without a paid request and exports narration without production instructions", async () => {
  render(draft);
  expect(generate).not.toHaveBeenCalled();
  await click("Лише озвучення");
  expect(container.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value).toBe("Озвучення 1.\n\nОзвучення 2.");
});
it("keeps the previous draft when regeneration fails and warns about stale sources", async () => {
  generate.mockResolvedValue({ status: "error", message: "OpenAI 401" });
  render(draft, "b".repeat(64));
  expect(container.textContent).toContain("Матеріали уроку змінилися");
  await click("Підготувати новий сценарій через OpenAI");
  expect(container.textContent).toContain("OpenAI 401");
  expect(container.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value).toContain("Озвучення 1");
});
it("requires an explicit click and warns if the successful result could not be saved", async () => {
  generate.mockResolvedValue({ status: "ok", draft, saved: false });
  render();
  expect(generate).not.toHaveBeenCalled();
  await click("Підготувати сценарій через OpenAI");
  expect(generate).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Завантажте TXT");
});
it("prevents a second request while generation is pending", async () => {
  let finish!: (result: { status: "ok"; draft: VideoDraft; saved: boolean }) => void;
  generate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render();
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === "Підготувати сценарій через OpenAI")!;
  await act(async () => { button.click(); button.click(); });
  expect(generate).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  await act(async () => { finish({ status: "ok", draft, saved: true }); });
  expect(button.disabled).toBe(false);
});
