// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceTurn } from "@/lib/voice";
import { VoiceConversation } from "./VoiceConversation";

const waitFeedback = vi.hoisted(() => ({ play: vi.fn(), stop: vi.fn() }));
vi.mock("./waitingFeedback", () => ({ playWaitingFeedback: waitFeedback.play }));
vi.mock("@/components/shared/singleAudioPlayback", () => ({ stopCurrentlyPlaying: vi.fn() }));

const onTurn = vi.fn();
const onActiveChange = vi.fn();
const fetchMock = vi.fn();
const microphone = vi.fn();
const track = { stop: vi.fn(), onended: null as (() => void) | null, enabled: true };
const mic = { getTracks: () => [track] };
let volume = 0;
let detectorThrows = false;
let recorderThrows = false;
const sources: MockSource[] = [];
const contexts: MockAudioContext[] = [];
const recordings: MockRecorder[] = [];

class MockSource {
  buffer: unknown;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class MockAudioContext {
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  decodeAudioData = vi.fn().mockResolvedValue({ duration: 1 });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 1024,
    getFloatTimeDomainData: (samples: Float32Array) => {
      if (detectorThrows) throw new Error("Audio hardware lost");
      samples.fill(volume);
    },
  }));
  createBufferSource = vi.fn(() => {
    const source = new MockSource();
    sources.push(source);
    return source;
  });
  constructor() { contexts.push(this); }
}
class MockRecorder {
  static isTypeSupported = vi.fn(() => true);
  state: "recording" | "inactive" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded voice"], { type: "audio/webm" }) });
    this.onstop?.();
  });
  constructor() {
    if (recorderThrows) throw new Error("Recorder unavailable");
    recordings.push(this);
  }
}
const lease = { id: "voice-session", expiresAt: "2026-10-21T12:01:00Z" };
const answer: VoiceTurn = {
  text: "Чому небо блакитне?",
  message: { id: "reply", author: "ai", content: "Це через розсіювання світла.", createdAt: "2026-10-21T12:00:00Z" },
  audio: { audioBase64: "AAAA", mimeType: "audio/mpeg" },
};
function response(data: unknown) { return { ok: true, json: async () => data } as Response; }
function sessionBodies() {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/voice/session").map(([, options]) => JSON.parse(options.body));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let container: HTMLDivElement;
let root: Root | null;
let mediaDescriptor: PropertyDescriptor | undefined;
let visibilityDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  waitFeedback.stop.mockReset();
  waitFeedback.play.mockReset().mockReturnValue(waitFeedback.stop);
  onTurn.mockReset();
  onActiveChange.mockReset();
  fetchMock.mockReset();
  track.stop.mockReset();
  track.onended = null;
  track.enabled = true;
  volume = 0;
  detectorThrows = false;
  recorderThrows = false;
  sources.length = 0;
  contexts.length = 0;
  recordings.length = 0;
  microphone.mockReset().mockResolvedValue(mic);
  mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: microphone } });
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("MediaRecorder", MockRecorder);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) => response(url === "/api/voice/turn" ? answer : lease));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<VoiceConversation target={{ kind: "course", refTable: "course_v2_screens", refId: "screen-1" }} onTurn={onTurn} onActiveChange={onActiveChange} />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function button(text: string) {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
}
async function click(text: string) {
  const found = button(text);
  if (!found) throw new Error(`Missing button ${text}`);
  await act(async () => { found.click(); });
}
async function start() { await click("🎙 Поговорити голосом"); }
// UI/UX decision 2026-10-22: sound feedback now defaults OFF (opt-in), so
// tests exercising the acknowledgement-sound behaviour must enable it first.
async function enableWaitingSound() {
  const toggle = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
  await act(async () => { toggle.click(); });
}
async function utterance() {
  volume = 0.1;
  await act(async () => { vi.advanceTimersByTime(160); });
  volume = 0;
  await act(async () => { vi.advanceTimersByTime(1000); });
}

describe("VoiceConversation microphone and session lifecycle", () => {
  it("acknowledges a slow answer once, keeps the microphone paused, then stops feedback before the real answer", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url: string) => url === "/api/voice/turn" ? pending.promise : Promise.resolve(response(lease)));
    await start();
    await enableWaitingSound();
    await utterance();
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(waitFeedback.play).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(waitFeedback.play).toHaveBeenCalledExactlyOnceWith(contexts[0], "Добре, обміркую відповідь.");
    expect(recordings).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(10_800); });
    expect(waitFeedback.play).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Готую відповідь · 12 с");
    expect(container.textContent).toContain("Повторювати запитання зараз не потрібно");
    await act(async () => { pending.resolve(response(answer)); });
    expect(waitFeedback.stop).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(1);
    expect(waitFeedback.stop.mock.invocationCallOrder[0]).toBeLessThan(sources[0]!.start.mock.invocationCallOrder[0]!);
    expect(container.textContent).not.toContain("Готую відповідь ·");
  });

  it("does not produce a delayed acknowledgement after cancellation", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url: string) => url === "/api/voice/turn" ? pending.promise : Promise.resolve(response(lease)));
    await start();
    await enableWaitingSound();
    await utterance();
    await click("Завершити голос");
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(waitFeedback.play).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pagehide", "lesson-navigation", "visibilitychange"])("cancels active waiting sound and all timers on %s", async event => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url: string) => url === "/api/voice/turn" ? pending.promise : Promise.resolve(response(lease)));
    await start();
    await enableWaitingSound();
    await utterance();
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(waitFeedback.play).toHaveBeenCalledOnce();
    if (event === "visibilitychange") {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      act(() => { document.dispatchEvent(new Event(event)); });
    } else act(() => { window.dispatchEvent(new Event(event)); });
    expect(waitFeedback.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { pending.resolve(response(answer)); });
    expect(sources).toHaveLength(0);
  });

  it("lets the child silence waiting feedback without cancelling the answer", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url: string) => url === "/api/voice/turn" ? pending.promise : Promise.resolve(response(lease)));
    await start();
    await enableWaitingSound();
    await utterance();
    await act(async () => { vi.advanceTimersByTime(1200); });
    const toggle = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => { toggle.click(); });
    expect(toggle.checked).toBe(false);
    expect(waitFeedback.stop).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(response(answer)); });
    expect(onTurn).toHaveBeenCalledWith(answer);
    expect(sources[0]!.start).toHaveBeenCalledOnce();
  });

  it("does not let an old cancelled response clear the next turn's waiting feedback", async () => {
    const old = deferred<Response>();
    const next = deferred<Response>();
    let turn = 0;
    fetchMock.mockImplementation((url: string) => url === "/api/voice/turn" ? (++turn === 1 ? old.promise : next.promise) : Promise.resolve(response(lease)));
    await start();
    await enableWaitingSound();
    await utterance();
    await click("Завершити голос");
    await start();
    // waitingSoundEnabled is a UI preference, not session state — "Завершити
    // голос" above does not reset it, so it is still on from enableWaitingSound() above.
    await utterance();
    await act(async () => { old.resolve(response(answer)); });
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(waitFeedback.play).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Обмірковую відповідь");
    expect(onTurn).not.toHaveBeenCalled();
    await click("Завершити голос");
  });

  it("keeps text available without starting a lease when the browser cannot record", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    await start();
    expect(container.textContent).toContain("У цьому браузері голос недоступний");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(microphone).not.toHaveBeenCalled();
    expect(onActiveChange).not.toHaveBeenCalled();
  });

  it("does not open the microphone when authentication redirects the lease request to HTML", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError("Unexpected HTML"); } });
    await start();
    expect(microphone).not.toHaveBeenCalled();
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Зараз голос недоступний");
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the lease and audio context after microphone permission is denied", async () => {
    microphone.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    await start();
    expect(container.textContent).toContain("Дозволь доступ до мікрофона");
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(sessionBodies()).toContainEqual({ id: lease.id, action: "stop" });
    expect(onActiveChange.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops microphone, recorder, context and timers when explicitly ended", async () => {
    await start();
    expect(recordings).toHaveLength(1);
    expect(container.textContent).toContain("Слухаю тебе");
    await click("Завершити голос");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recordings[0]!.stop).toHaveBeenCalledOnce();
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(sessionBodies()).toContainEqual({ id: lease.id, action: "stop" });
    expect(vi.getTimerCount()).toBe(0);
    const requests = fetchMock.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(65_000); });
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    expect(onTurn).not.toHaveBeenCalled();
  });

  it("releases a late microphone stream after unmount without producing a turn", async () => {
    const pending = deferred<typeof mic>();
    microphone.mockReturnValueOnce(pending.promise);
    await start();
    act(() => { root!.unmount(); root = null; });
    await act(async () => { pending.resolve(mic); });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(sessionBodies()).toContainEqual({ id: lease.id, action: "stop" });
    expect(recordings).toHaveLength(0);
    expect(onTurn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a late server lease when stop happened before the lease request completed", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    await start();
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    await click("Завершити голос");
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { pending.resolve(response(lease)); });
    expect(sessionBodies()).toContainEqual({ id: lease.id, action: "stop" });
    expect(microphone).not.toHaveBeenCalled();
    expect(onTurn).not.toHaveBeenCalled();
  });

  it("returns to idle and releases the old microphone when the chat target changes", async () => {
    await start();
    await act(async () => {
      root!.render(<VoiceConversation target={{ kind: "course", refTable: "course_v2_screens", refId: "screen-2" }} onTurn={onTurn} onActiveChange={onActiveChange} />);
    });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(button("🎙 Поговорити голосом")).toBeDefined();
    expect(button("Завершити голос")).toBeUndefined();
    expect(container.textContent).toContain("Голос вимкнено");
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pagehide", "visibilitychange", "lesson-navigation"])("stops the microphone on background/navigation (%s)", async (event) => {
    await start();
    if (event === "visibilitychange") {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      act(() => { document.dispatchEvent(new Event(event)); });
    } else act(() => { window.dispatchEvent(new Event(event)); });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Голосову розмову зупинено");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops before another voice panel opens a microphone", async () => {
    await start();
    act(() => { window.dispatchEvent(new CustomEvent("lesson-voice-start", { detail: "another-panel" })); });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(sessionBodies()).toContainEqual({ id: lease.id, action: "stop" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the session after 60 seconds of silence without sending audio to a paid endpoint", async () => {
    await start();
    await act(async () => { vi.advanceTimersByTime(60_100); });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/voice/turn")).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Зробімо паузу");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["detector", "recorder"])("cleans up if the %s fails after the microphone started", async (failure) => {
    if (failure === "recorder") recorderThrows = true;
    await start();
    if (failure === "detector") {
      detectorThrows = true;
      await act(async () => { vi.advanceTimersByTime(80); });
    }
    expect(track.stop).toHaveBeenCalledOnce();
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Зараз голос недоступний");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays the saved answer and supports a button interruption before listening again", async () => {
    await start();
    await utterance();
    expect(onTurn).toHaveBeenCalledWith(answer);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.start).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Репетитор відповідає");
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(waitFeedback.play).not.toHaveBeenCalled();
    await click("Перебити і говорити");
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(recordings).toHaveLength(2);
    expect(container.textContent).toContain("Слухаю тебе");
  });

  it("does not label a normally ended session as a personal safety emergency", async () => {
    const inactive = { ...answer, audio: null, endConversation: true, endReason: "inactive" };
    fetchMock.mockImplementation(async (url: string) => response(url === "/api/voice/turn" ? inactive : lease));
    await start();
    await utterance();
    expect(container.textContent).toContain("Розмову завершено.");
    expect(container.textContent).not.toContain("зараз піди й поговори з татом");
    expect(recordings).toHaveLength(1);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(0);
  });

  it("cannot interrupt an urgent safety reply to resume the conversation", async () => {
    const urgent = { ...answer, endConversation: true };
    fetchMock.mockImplementation(async (url: string) => response(url === "/api/voice/turn" ? urgent : lease));
    await start();
    await utterance();
    expect(onTurn).toHaveBeenCalledWith(urgent);
    expect(button("Перебити і говорити")).toBeUndefined();
    expect(sources).toHaveLength(1);
    act(() => { sources[0]!.onended?.(); });
    expect(recordings).toHaveLength(1);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("зараз піди й поговори з татом");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mutes mid-listening without sending the dropped recording, then resumes a fresh one on unmute", async () => {
    await start();
    expect(recordings).toHaveLength(1);
    await click("🔇 Мікрофон на паузу");
    expect(track.enabled).toBe(false);
    expect(recordings[0]!.stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Мікрофон на паузі");
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/voice/turn")).toBe(false);
    await click("🎙 Увімкнути мікрофон");
    expect(track.enabled).toBe(true);
    expect(recordings).toHaveLength(2);
    expect(container.textContent).toContain("Слухаю тебе");
  });

  it("keeps a reply playing while muted and waits (without a new recording) once it ends", async () => {
    await start();
    await utterance();
    expect(container.textContent).toContain("Репетитор відповідає");
    await click("🔇 Мікрофон на паузу");
    expect(track.enabled).toBe(false);
    expect(container.textContent).toContain("Репетитор відповідає");
    act(() => { sources[0]!.onended?.(); });
    expect(recordings).toHaveLength(1);
    expect(container.textContent).toContain("Мікрофон на паузі");
    await click("🎙 Увімкнути мікрофон");
    expect(recordings).toHaveLength(2);
  });

  it("does not resume listening on interrupt while muted", async () => {
    await start();
    await utterance();
    await click("🔇 Мікрофон на паузу");
    await click("Перебити і говорити");
    expect(sources[0]!.stop).toHaveBeenCalledOnce();
    expect(recordings).toHaveLength(1);
    expect(container.textContent).toContain("Мікрофон на паузі");
    await click("🎙 Увімкнути мікрофон");
    expect(recordings).toHaveLength(2);
  });

  it("resets mute state when the session ends", async () => {
    await start();
    await click("🔇 Мікрофон на паузу");
    await click("Завершити голос");
    await start();
    expect(button("🔇 Мікрофон на паузу")).toBeDefined();
    expect(button("🎙 Увімкнути мікрофон")).toBeUndefined();
  });

  it("ignores a late turn response after stop and never starts playback", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url: string) => url === "/api/voice/turn" ? pending.promise : Promise.resolve(response(lease)));
    await start();
    await utterance();
    expect(container.textContent).toContain("Обмірковую відповідь");
    await click("Завершити голос");
    await act(async () => { pending.resolve(response(answer)); });
    expect(onTurn).not.toHaveBeenCalled();
    expect(sources).toHaveLength(0);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
