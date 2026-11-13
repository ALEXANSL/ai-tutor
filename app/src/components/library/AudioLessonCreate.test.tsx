// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ create: vi.fn(), options: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: f.push }) }));
vi.mock("@/app/actions/audiobooks", () => ({ createAudioPartAction: f.create, audioLessonOptionsAction: f.options }));
import { AudioLessonCreate } from "./AudioLessonCreate";
let container: HTMLDivElement, root: Root;
const subjectId = "11111111-1111-4111-8111-111111111111", topicId = "22222222-2222-4222-8222-222222222222";
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); f.create.mockResolvedValue({ status: "error", message: "Перевір стан" }); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function render() { act(() => root.render(<AudioLessonCreate subjects={[{ id: subjectId, name: "Географія" }]} subjectId={subjectId} topicId={topicId} lessons={[{ id: topicId, title: "§16. Природа" }]} />)); }
it("creates a lesson source without pages only after consent and reuses request ID after uncertainty", async () => {
  render(); const submit = container.querySelector<HTMLButtonElement>('button')!;
  expect(submit.disabled).toBe(true); act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const form = container.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  const first = f.create.mock.calls[0]![0]; expect(first.request.lesson).toEqual({ subjectId, topicId }); expect(first.request.materialId).toBe(subjectId); expect(first.request.from).toBe(1); expect(first.request.to).toBe(1);
  f.create.mockResolvedValue({ status: "ok", id: first.id });
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(f.create.mock.calls[1]![0].id).toBe(first.id); expect(f.push).toHaveBeenCalledWith(`/parent/audiobooks/${first.id}`);
});
