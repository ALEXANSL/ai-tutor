// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NarrationButton } from "./NarrationButton";
import { AudioNavigationBoundary } from "./AudioNavigationBoundary";
import { beginAudioPlayback, isCurrentlyPlaying, playSingleAudio, stopCurrentlyPlaying } from "./singleAudioPlayback";

const navigation = vi.hoisted(() => ({ pathname: "/lesson/first" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

const created: MockAudio[] = [];
class MockAudio extends EventTarget {
  playbackRate = 1;
  paused = true;
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
  constructor(public src: string) { super(); created.push(this); }
}
function asAudio(audio: MockAudio) { return audio as unknown as HTMLAudioElement; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const speech = { status: "ok" as const, audioMime: "audio/mpeg", audioBase64: "AAAA" };
let container: HTMLDivElement;
let root: Root | null;
beforeEach(() => {
  stopCurrentlyPlaying();
  created.length = 0;
  navigation.pathname = "/lesson/first";
  window.history.replaceState(null, "", "/lesson/first");
  vi.stubGlobal("Audio", MockAudio);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  stopCurrentlyPlaying();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function clickButton(index = 0) {
  await act(async () => { container.querySelectorAll("button")[index]!.click(); });
}

describe("narration request ownership", () => {
  it("never creates audio when pending synthesis resolves after unmount", async () => {
    const pending = deferred<typeof speech>();
    act(() => root!.render(<NarrationButton identity="screen-a" text="A" synthesize={() => pending.promise} />));
    await clickButton();
    act(() => { root!.unmount(); root = null; });
    await act(async () => { pending.resolve(speech); });
    expect(created).toHaveLength(0);
  });

  it("pauses active detached audio when its button unmounts", async () => {
    act(() => root!.render(<NarrationButton identity="screen-a" text="A" synthesize={async () => speech} />));
    await clickButton();
    expect(created[0]!.play).toHaveBeenCalledOnce();
    act(() => { root!.unmount(); root = null; });
    expect(created[0]!.pause).toHaveBeenCalledOnce();
    expect(isCurrentlyPlaying(asAudio(created[0]!))).toBe(false);
  });

  it("drops an old screen's late response when the same button receives another content identity", async () => {
    const pending = deferred<typeof speech>();
    act(() => root!.render(<NarrationButton identity="screen-a" text="A" synthesize={() => pending.promise} />));
    await clickButton();
    act(() => root!.render(<NarrationButton identity="screen-b" text="B" synthesize={async () => speech} />));
    await clickButton();
    expect(created).toHaveLength(1);
    await act(async () => { pending.resolve(speech); });
    expect(created).toHaveLength(1);
    expect(isCurrentlyPlaying(asAudio(created[0]!))).toBe(true);
  });

  it("lets a newer request win without a late old response stealing playback", async () => {
    const first = deferred<typeof speech>();
    const second = deferred<typeof speech>();
    act(() => root!.render(<>
      <NarrationButton identity="a" text="A" synthesize={() => first.promise} />
      <NarrationButton identity="b" text="B" synthesize={() => second.promise} />
    </>));
    await clickButton(0);
    await clickButton(1);
    expect(container.querySelectorAll("button")[0]!.disabled).toBe(false);
    await act(async () => { second.resolve(speech); });
    await act(async () => { first.resolve(speech); });
    expect(created).toHaveLength(1);
    expect(created[0]!.play).toHaveBeenCalledOnce();
  });

  it("stops immediately when voice mode is switched off and restarts only when switched on", async () => {
    const synthesize = vi.fn().mockResolvedValue(speech);
    await act(async () => root!.render(<NarrationButton identity="a" text="A" synthesize={synthesize} autoPlay />));
    expect(created).toHaveLength(1);
    act(() => root!.render(<NarrationButton identity="a" text="A" synthesize={synthesize} autoPlay={false} />));
    expect(created[0]!.pause).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledOnce();
    await act(async () => root!.render(<NarrationButton identity="a" text="A" synthesize={synthesize} autoPlay />));
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(2);
  });

  it("advances only after natural completion, never after cancellation or a late ended event", async () => {
    const onEnded = vi.fn();
    act(() => root!.render(<NarrationButton identity="a" text="A" synthesize={async () => speech} onEnded={onEnded} />));
    await clickButton();
    act(() => stopCurrentlyPlaying());
    act(() => created[0]!.dispatchEvent(new Event("ended")));
    expect(onEnded).not.toHaveBeenCalled();
    await clickButton();
    act(() => created[1]!.dispatchEvent(new Event("ended")));
    expect(onEnded).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("🔊 Слухати");
  });
});

describe("single playback manager", () => {
  it("stops prior audio once and preserves the supplied playback speed", async () => {
    const a = new MockAudio("a"), b = new MockAudio("b");
    const stopped = vi.fn();
    a.playbackRate = 1.5;
    playSingleAudio(asAudio(a), stopped);
    expect(a.playbackRate).toBe(1.5);
    playSingleAudio(asAudio(b), vi.fn());
    expect(a.pause).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    expect(isCurrentlyPlaying(asAudio(b))).toBe(true);
    a.dispatchEvent(new Event("ended"));
    expect(stopped).toHaveBeenCalledOnce();
    await Promise.resolve();
  });

  it("ignores a stale rejected play promise instead of stopping the newer audio", async () => {
    const pending = deferred<void>();
    const a = new MockAudio("a"), b = new MockAudio("b");
    a.play.mockReturnValueOnce(pending.promise);
    const aStopped = vi.fn(), bStopped = vi.fn();
    playSingleAudio(asAudio(a), aStopped);
    playSingleAudio(asAudio(b), bStopped);
    pending.reject(new Error("autoplay cancelled"));
    await Promise.resolve(); await Promise.resolve();
    expect(aStopped).toHaveBeenCalledOnce();
    expect(bStopped).not.toHaveBeenCalled();
    expect(isCurrentlyPlaying(asAudio(b))).toBe(true);
  });
});

describe("navigation audio boundary", () => {
  it("invalidates pending audio as soon as an internal navigation link is clicked", async () => {
    act(() => root!.render(<><AudioNavigationBoundary /><a href="/today" onClick={(event) => event.preventDefault()}>Home</a></>));
    const request = beginAudioPlayback(vi.fn());
    act(() => container.querySelector("a")!.click());
    expect(request.isCurrent()).toBe(false);
  });

  it("stops detached and native audio when the route changes through the router", () => {
    act(() => root!.render(<><AudioNavigationBoundary /><audio /></>));
    const audio = new MockAudio("detached");
    playSingleAudio(asAudio(audio), vi.fn());
    navigation.pathname = "/today";
    act(() => root!.render(<><AudioNavigationBoundary /><audio /></>));
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it.each(["popstate", "pagehide"])("stops current playback on %s", (event) => {
    act(() => root!.render(<AudioNavigationBoundary />));
    const audio = new MockAudio("detached");
    playSingleAudio(asAudio(audio), vi.fn());
    act(() => window.dispatchEvent(new Event(event)));
    expect(audio.pause).toHaveBeenCalledOnce();
  });
});
