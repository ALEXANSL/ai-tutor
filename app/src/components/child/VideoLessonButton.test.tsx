// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), stop: vi.fn() }));
vi.mock("@/app/actions/video-lessons", () => ({ getVideoLessonUrlAction: mocks.get, listTopicVideosAction: mocks.list }));
vi.mock("@/components/shared/singleAudioPlayback", () => ({ stopCurrentlyPlaying: mocks.stop }));
import { VideoLessonButton } from "./VideoLessonButton";
let root: Root, container: HTMLDivElement;
const pause = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  mocks.list.mockResolvedValue([{ id: "video", label: "Відео 1" }]);
  mocks.get.mockResolvedValue({ status: "ok", url: "https://example.com/signed.mp4" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  act(() => root.render(<VideoLessonButton topicId="topic" title="Параграф 16" />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open() { await act(async () => container.querySelector("button")!.click()); }
function closeButton() { return document.querySelector<HTMLButtonElement>('[role="dialog"] button')!; }
describe("optional video modal", () => {
  it("signs on open only, stops narration and provides native inline controls", async () => {
    expect(mocks.get).not.toHaveBeenCalled(); await open();
    expect(mocks.stop).toHaveBeenCalled(); expect(mocks.get).toHaveBeenCalledWith("video");
    const video = document.querySelector("video")!;
    expect(video.controls).toBe(false); expect(video.playsInline).toBe(true);
    Object.defineProperty(video, "duration", { configurable: true, value: 180 });
    Object.defineProperty(video, "buffered", { configurable: true, value: { length: 1, start: () => 0, end: () => 60 } });
    act(() => video.dispatchEvent(new Event("progress")));
    expect(video.controls).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby")).toBeTruthy();
    act(() => closeButton().click()); expect(pause).toHaveBeenCalled(); expect(document.querySelector("video")).toBeNull();
  });
  it("shows a retry for action exceptions and playback errors", async () => {
    mocks.get.mockRejectedValueOnce(new Error("network down")); await open();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Спробувати ще раз")!.click());
    expect(document.querySelector("video")).not.toBeNull();
    act(() => document.querySelector("video")!.dispatchEvent(new Event("error")));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("ignores a late response from an earlier open after closing and reopening", async () => {
    let resolve!: (value: { status: string; url: string }) => void;
    mocks.get.mockReturnValueOnce(new Promise(done => { resolve = done; })); await open();
    act(() => closeButton().click()); await open();
    await act(async () => resolve({ status: "ok", url: "https://example.com/old.mp4" }));
    expect(document.querySelector("video")!.src).toBe("https://example.com/signed.mp4");
  });
  it("Escape restores focus and scroll, and navigation also closes the player", async () => {
    container.querySelector("button")!.focus(); await open();
    expect(document.body.style.overflow).toBe("hidden"); expect(document.activeElement).toBe(closeButton());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(container.querySelector("button"));
    await open(); act(() => window.dispatchEvent(new Event("lesson-navigation")));
    expect(document.querySelector("video")).toBeNull();
  });
  it("stops playing media when unmounted", async () => {
    await open(); pause.mockClear(); act(() => root.render(null)); expect(pause).toHaveBeenCalled();
  });
});
