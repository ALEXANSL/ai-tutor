// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const id = "11111111-1111-4111-8111-111111111111";
const f = vi.hoisted(() => ({ open: vi.fn(), put: vi.fn(), complete: vi.fn(), status: vi.fn(), resume: vi.fn() }));
vi.mock("@/lib/upload-source", () => ({ openSourceUpload: f.open, putSourceUpload: f.put, completeSourceUpload: f.complete, SourceUploadError: class SourceUploadError extends Error {} }));
vi.mock("@/app/actions/studio-sources", () => ({ studioSourceStatusAction: f.status, resumeStudioSourceAction: f.resume }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
import { StudioSourceUpload } from "./StudioSourceUpload";
let container: HTMLDivElement, root: Root;
const ready = { id, title: "Презентація", status: "ready", progress: {}, pageCount: 3, charCount: 300, ocrPages: null, ocrCost: 0, hasText: true, preview: "Перший слайд", warnings: ["Ілюстрації не розпізнавалися"], detail: null };
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); f.open.mockResolvedValue("session"); f.put.mockResolvedValue("DriveId123"); f.complete.mockResolvedValue(id); f.status.mockResolvedValue(ready); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function pick(name = "slides.pptx") {
  const input = container.querySelector('input[type="file"]')!; Object.defineProperty(input, "files", { configurable: true, value: [new File(["real file contents"], name, { type: "application/octet-stream" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
async function click(label: string) { await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent?.includes(label))!.click(); }); }
it("selecting a file does not upload/spend until the parent's explicit action, then shows the recognized source", async () => {
  await act(async () => root.render(<StudioSourceUpload enabled />)); await pick(); expect(f.open).not.toHaveBeenCalled();
  await click("Завантажити й обробити"); expect(f.open).toHaveBeenCalledOnce(); expect(f.complete).toHaveBeenCalledWith("DriveId123");
  expect(container.textContent).toContain("Текст доступний"); expect(container.textContent).toContain("Ілюстрації не розпізнавалися"); expect(container.textContent).toContain("Перший слайд");
  expect(container.querySelector(`a[href="/parent/studio/new?material=${id}"]`)).not.toBeNull();
});
it("confirmation retry uses the saved Drive file instead of uploading a duplicate", async () => {
  f.complete.mockRejectedValueOnce(new Error("temporary confirmation error"));
  await act(async () => root.render(<StudioSourceUpload enabled />)); await pick(); await click("Завантажити й обробити"); await click("Повторити завершення");
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.put).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(2); expect(container.textContent).toContain("Текст доступний");
});
it("does not require the parent to leave the form to approve a large PDF scan", async () => {
  f.status.mockResolvedValue({ ...ready, hasText: false, preview: "", status: "scan_awaiting_ocr", ocrPages: 50, ocrCost: 0.2 });
  await act(async () => root.render(<StudioSourceUpload enabled selectedId={id} onSelect={() => {}} />));
  expect(container.textContent).toContain("0.200"); await click("Погоджую розпізнавання"); expect(f.resume).toHaveBeenCalledWith(id, true);
});
it("uses the existing selected library material without uploading it again", async () => {
  const readyState = vi.fn(); await act(async () => root.render(<StudioSourceUpload enabled selectedId={id} onSelect={() => {}} onReady={readyState} />));
  expect(f.status).toHaveBeenCalledWith(id); expect(readyState).toHaveBeenLastCalledWith(true); expect(f.open).not.toHaveBeenCalled();
});
it("shows a real configuration link when local uploads are not connected", async () => {
  await act(async () => root.render(<StudioSourceUpload enabled={false} />)); expect(container.querySelector('input[type="file"]')).toBeNull(); expect(container.querySelector('a[href="/parent/settings"]')).not.toBeNull();
});

it("retains exercise selection from photo recognition inside the unified uploader", async () => {
  const tasks = vi.fn(); f.status.mockResolvedValue({ ...ready, tasks: [{ label: "3", text: "Übung: Guten Tag!" }] });
  await act(async () => root.render(<StudioSourceUpload enabled selectedId={id} onSelect={() => {}} onTasks={tasks} />));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await click("Додати вибрані вправи");
  expect(tasks).toHaveBeenCalledWith("3: Übung: Guten Tag!");
});
