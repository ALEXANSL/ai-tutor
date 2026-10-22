// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { playWaitingFeedback } from "./waitingFeedback";

class Utterance {
  voice: unknown;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
function audioFixture() {
  const oscillator = { type: "", frequency: { value: 0 }, onended: null as (() => void) | null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  const context = { currentTime: 10, destination: {}, createOscillator: vi.fn(() => oscillator), createGain: vi.fn(() => gain) };
  return { oscillator, gain, context };
}
afterEach(() => vi.unstubAllGlobals());

describe("device-local waiting acknowledgement", () => {
  it("speaks only a fixed acknowledgement with a local Ukrainian voice and cancels owned speech", () => {
    const voice = { lang: "uk-UA", localService: true };
    const synthesis = { getVoices: () => [{ lang: "en-US", localService: true }, voice], speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    const { context } = audioFixture();
    const stop = playWaitingFeedback(context as unknown as AudioContext, "Добре, обміркую відповідь.");
    expect(synthesis.speak).toHaveBeenCalledOnce();
    expect(synthesis.speak.mock.calls[0]![0]).toMatchObject({ text: "Добре, обміркую відповідь.", lang: "uk-UA", voice });
    expect(context.createOscillator).not.toHaveBeenCalled();
    stop(); stop();
    expect(synthesis.cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel another utterance after its own acknowledgement finished", () => {
    const synthesis = { getVoices: () => [{ lang: "uk-UA", localService: true }], speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    const { context } = audioFixture();
    const stop = playWaitingFeedback(context as unknown as AudioContext, "Добре.");
    synthesis.speak.mock.calls[0]![0].onend();
    stop();
    expect(synthesis.cancel).not.toHaveBeenCalled();
  });

  it("falls back once when a local voice fails asynchronously and stops that tone on cancellation", () => {
    const synthesis = { getVoices: () => [{ lang: "uk-UA", localService: true }], speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    const { context, oscillator } = audioFixture();
    const stop = playWaitingFeedback(context as unknown as AudioContext, "Добре.");
    const failed = synthesis.speak.mock.calls[0]![0].onerror;
    failed(); failed();
    expect(context.createOscillator).toHaveBeenCalledOnce();
    stop();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(synthesis.cancel).not.toHaveBeenCalled();
  });

  it("does not start a fallback for a stale speech error after cancellation", () => {
    const synthesis = { getVoices: () => [{ lang: "uk-UA", localService: true }], speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    const { context } = audioFixture();
    const stop = playWaitingFeedback(context as unknown as AudioContext, "Добре.");
    const lateError = synthesis.speak.mock.calls[0]![0].onerror;
    stop();
    lateError();
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(synthesis.cancel).toHaveBeenCalledOnce();
  });

  it.each([{ voices: [] }, { voices: [{ lang: "uk-UA", localService: false }] }, { voices: [{ lang: "en-US", localService: true }] }])("uses one soft tone rather than a remote or wrong-language voice", ({ voices }) => {
    const synthesis = { getVoices: () => voices, speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal("speechSynthesis", synthesis);
    const { context, oscillator, gain } = audioFixture();
    const stop = playWaitingFeedback(context as unknown as AudioContext, "Добре.");
    expect(synthesis.speak).not.toHaveBeenCalled();
    expect(oscillator.start).toHaveBeenCalledExactlyOnceWith(10);
    expect(oscillator.stop).toHaveBeenCalledWith(10.22);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.035, 10.025);
    stop();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
  });

  it("degrades silently when the device has neither speech nor an audio output", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(() => playWaitingFeedback({} as AudioContext, "Добре.")()).not.toThrow();
  });
});
