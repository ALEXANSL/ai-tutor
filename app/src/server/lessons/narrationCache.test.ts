import { describe, expect, it, vi } from "vitest";

/**
 * PO complaint 2026-10-02 ("до 30 секунд поки ШІ починає читати вголос",
 * no caching at all before this): `getOrSynthesizeStepNarration` must (1)
 * return a cached row's audio with NO call to the TTS provider, (2)
 * synthesize + persist on a genuine cache miss, and (3) still return the
 * freshly-synthesized audio even if the cache WRITE fails (caching is a
 * pure optimization, never allowed to turn a successful synthesis into a
 * lost narration).
 */

const synthesizeStepNarration = vi.fn();
vi.mock("@/server/lessons/narration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./narration")>();
  return { ...actual, synthesizeStepNarration: (...args: unknown[]) => synthesizeStepNarration(...args) };
});

let updateError: Error | null = null;
const updateCalls: Record<string, unknown>[] = [];
vi.mock("@/server/db/family-scope", () => ({
  forFamily: () => ({
    update: (_table: string, values: Record<string, unknown>) => {
      updateCalls.push(values);
      return {
        eq: async () => {
          if (updateError) throw updateError;
          return { error: null };
        },
      };
    },
  }),
}));

const { getOrSynthesizeStepNarration } = await import("./narrationCache");
const { narrationTextHash } = await import("./narration");

function stepRow(over: Partial<Parameters<typeof getOrSynthesizeStepNarration>[2]> = {}) {
  return {
    id: "step-1",
    type: "slide",
    content: { textUk: "Дроби." },
    narration_text_hash: null,
    narration_audio_base64: null,
    narration_audio_mime: null,
    ...over,
  };
}

describe("getOrSynthesizeStepNarration", () => {
  it("returns null without calling TTS when the step has no readable text", async () => {
    const result = await getOrSynthesizeStepNarration("fam1", "sess1", stepRow({ content: {} }));
    expect(result).toBeNull();
    expect(synthesizeStepNarration).not.toHaveBeenCalled();
  });

  it("returns the cached audio on a hash hit, with no TTS call", async () => {
    const hash = narrationTextHash("Дроби.");
    const row = stepRow({ narration_text_hash: hash, narration_audio_base64: "cached-b64", narration_audio_mime: "audio/mpeg" });
    const result = await getOrSynthesizeStepNarration("fam1", "sess1", row);
    expect(result).toEqual({ audioBase64: "cached-b64", mimeType: "audio/mpeg" });
    expect(synthesizeStepNarration).not.toHaveBeenCalled();
  });

  it("synthesizes and persists the cache on a miss (e.g. first time, or a stale hash after a content edit)", async () => {
    updateCalls.length = 0;
    synthesizeStepNarration.mockResolvedValueOnce({ audioBase64: "fresh-b64", mimeType: "audio/mpeg" });
    const row = stepRow({ narration_text_hash: "stale-hash", narration_audio_base64: "stale-b64", narration_audio_mime: "audio/mpeg" });
    const result = await getOrSynthesizeStepNarration("fam1", "sess1", row);
    expect(result).toEqual({ audioBase64: "fresh-b64", mimeType: "audio/mpeg" });
    expect(synthesizeStepNarration).toHaveBeenCalledWith("fam1", "sess1", "Дроби.");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      narration_text_hash: narrationTextHash("Дроби."),
      narration_audio_base64: "fresh-b64",
      narration_audio_mime: "audio/mpeg",
    });
  });

  it("still returns freshly-synthesized audio even if the cache write fails", async () => {
    updateError = new Error("db down");
    synthesizeStepNarration.mockResolvedValueOnce({ audioBase64: "fresh-b64", mimeType: "audio/mpeg" });
    const result = await getOrSynthesizeStepNarration("fam1", "sess1", stepRow());
    expect(result).toEqual({ audioBase64: "fresh-b64", mimeType: "audio/mpeg" });
    updateError = null;
  });

  it("returns null when synthesis itself fails/refuses (same silent fallback as before caching existed)", async () => {
    synthesizeStepNarration.mockResolvedValueOnce(null);
    const result = await getOrSynthesizeStepNarration("fam1", "sess1", stepRow());
    expect(result).toBeNull();
  });
});
