// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioPhotoSource } from "./StudioPhotoSource";
let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("does not spend OCR calls when choosing a photo, preserves recognition and exposes exercise selection", async () => {
  const fetchMock = vi.fn(async () => Response.json({ status: "ok", text: "Übung 3: Ergänze die Sätze. Guten Tag!", tasks: [{ label: "3", text: "Ergänze die Sätze." }], warnings: ["Нижній край сторінки обрізано"] })); vi.stubGlobal("fetch", fetchMock);
  const text = vi.fn(), tasks = vi.fn(); act(() => root.render(<StudioPhotoSource disabled={false} onText={text} onTasks={tasks} onBusy={() => {}} />));
  const input = container.querySelector('input[type="file"]')!; Object.defineProperty(input, "files", { value: [new File([new Uint8Array([255, 216, 255])], "page.jpg", { type: "image/jpeg" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true }))); expect(fetchMock).not.toHaveBeenCalled();
  const button = [...container.querySelectorAll("button")].find(node => node.textContent === "Розпізнати сторінку з ШІ")!;
  await act(async () => button.click()); expect(fetchMock).toHaveBeenCalledTimes(1); expect(text).toHaveBeenCalledWith(expect.stringContaining("Übung 3")); expect(container.querySelector("textarea")?.value).toContain("Guten Tag!"); expect(text.mock.calls[0]![0]).toContain("Нижній край сторінки обрізано");
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => [...container.querySelectorAll("button")].find(node => node.textContent?.includes("Додати вибрані"))!.click()); expect(tasks).toHaveBeenCalledWith("3: Ergänze die Sätze.");
});
