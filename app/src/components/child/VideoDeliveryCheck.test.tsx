// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ browser: vi.fn(), server: vi.fn() }));
vi.mock("@/lib/video-delivery-probe", () => ({ probeVideoDelivery: mock.browser }));
vi.mock("@/app/actions/video-lessons", () => ({ inspectVideoDeliveryAction: mock.server }));
import { VideoDeliveryCheck } from "./VideoDeliveryCheck";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  mock.browser.mockResolvedValue({ status: 206, bytes: 100, error: null }); mock.server.mockResolvedValue({ status: "ok", report: { status: 206, bytes: 100 } });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("suspends competing media before probing and does nothing until requested", async () => {
  const suspend = vi.fn();
  act(() => root.render(<VideoDeliveryCheck videoId="video" url="https://example.com/signed?token=PRIVATE" media={() => null} onSuspendPlayback={suspend} />));
  expect(mock.browser).not.toHaveBeenCalled(); expect(mock.server).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(mock.browser.mock.invocationCallOrder[0]!);
  expect(mock.server).toHaveBeenCalledWith("video");
  expect(container.querySelector("textarea")!.value).not.toContain("PRIVATE");
});
it("aborts browser probing on close and never starts the server probe afterward", async () => {
  let finish!: (value: object) => void;
  mock.browser.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  act(() => root.render(<VideoDeliveryCheck videoId="video" url="https://example.com/video" media={() => null} onSuspendPlayback={() => {}} />));
  await act(async () => container.querySelector("button")!.click());
  const signal = mock.browser.mock.calls[0]![1] as AbortSignal;
  act(() => root.render(null)); expect(signal.aborted).toBe(true);
  await act(async () => finish({ status: 206 })); expect(mock.server).not.toHaveBeenCalled();
});
