import { describe, expect, it } from "vitest";
import { narrationTextHash, readableTextForStep } from "./narration";

describe("readableTextForStep (US-6.16 КП-5, ADR-025)", () => {
  it("reads a slide's text and example", () => {
    expect(readableTextForStep({ type: "slide", content: { textUk: "Дроби.", exampleUk: "6/8 = 3/4." } })).toBe("Дроби.. 6/8 = 3/4.");
  });

  it("reads a choice step's question and options, in order", () => {
    const text = readableTextForStep({
      type: "choice",
      content: { questionUk: "Скороти дріб", options: [{ textUk: "4/6" }, { textUk: "2/3" }] },
    });
    expect(text).toBe("Скороти дріб. 4/6. 2/3");
  });

  it("reads an open step's question", () => {
    expect(readableTextForStep({ type: "open", content: { questionUk: "Чому 8/12 = 2/3?" } })).toBe("Чому 8/12 = 2/3?");
  });

  it("returns an empty string for a step with nothing readable (e.g. a pure interactive step)", () => {
    expect(readableTextForStep({ type: "interactive", content: {} })).toBe("");
  });
});

/**
 * PO complaint 2026-10-02 ("до 30 секунд поки ШІ починає читати вголос"):
 * `narrationTextHash` is the cache key `narrationCache.ts` uses to decide
 * between a cache hit (no AI call) and a genuine first-time/edited-text
 * miss — see migration `20261015100000_tts_narration_cache.sql`.
 */
describe("narrationTextHash (PO complaint 2026-10-02, narration caching)", () => {
  it("is stable for the exact same text", () => {
    expect(narrationTextHash("Дроби.")).toBe(narrationTextHash("Дроби."));
  });

  it("differs when the text differs (cache correctly misses after a content edit)", () => {
    expect(narrationTextHash("Дроби.")).not.toBe(narrationTextHash("Дроби!"));
  });

  it("normalizes the same way `synthesizeStepNarration` does (trim, same max-length cutoff) so both sides key identically", () => {
    expect(narrationTextHash("  Дроби.  ")).toBe(narrationTextHash("Дроби."));
  });
});

describe("narrationDeps (ADR-049: ElevenLabs first, family route as fallback)", async () => {
  const { narrationDeps, ELEVENLABS_PRICE } = await import("./narration");
  const { defaultRouterDeps } = await import("@/server/ai/router");
  const familyRoute = { role: "passive_narration", primary_provider: "openai", primary_model: "gpt-4o-mini-tts", fallback_provider: "gemini", fallback_model: "gemini-tts", escalation_provider: null, escalation_model: null, economy_provider: "openai", economy_model: "tts-1", params: {} };
  const base = { ...defaultRouterDeps, loadRoute: async () => familyRoute, loadPrice: async () => ({ input_usd_per_mtok: 1, output_usd_per_mtok: 0, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null }) };

  it("leaves the route untouched without a key", () => {
    expect(narrationDeps(() => null)).toBeUndefined();
  });

  it("puts ElevenLabs first and keeps OpenAI as the fallback when the key is set", async () => {
    const deps = narrationDeps((name) => (name === "ELEVENLABS_API_KEY" ? "k" : null), base)!;
    const route = await deps.loadRoute("f", "passive_narration");
    expect(route).toMatchObject({ primary_provider: "elevenlabs", primary_model: "eleven_multilingual_v2", fallback_provider: "openai", fallback_model: "gpt-4o-mini-tts", economy_model: null });
    expect(await deps.loadPrice("elevenlabs", "eleven_multilingual_v2")).toBe(ELEVENLABS_PRICE);
    expect((await deps.loadPrice("openai", "gpt-4o-mini-tts"))?.input_usd_per_mtok).toBe(1);
  });
});
