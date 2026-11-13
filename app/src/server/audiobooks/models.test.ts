import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ upsert: vi.fn(), route: vi.fn(), price: vi.fn(), call: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: () => ({ upsert: f.upsert }) }) }));
vi.mock("@/server/ai/store", () => ({ loadPrice: f.price }));
vi.mock("@/server/ai/router", () => ({ callAudio: f.call, callStructured: f.call, defaultRouterDeps: {} }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => ({ eq: () => ({ maybeSingle: f.route }) }) }) }));
import { audioModelConfig, audioReservation, narrateAudio, prepareAudioText, audioEditorialSystem, audioLessonSystem } from "./models";
beforeEach(() => { vi.clearAllMocks(); f.upsert.mockResolvedValue({ error: null }); f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "tts-1-hd", params: { max_tokens: 1, timeout_ms: 120000 } } }); f.price.mockResolvedValue({ input_usd_per_mtok: 30, output_usd_per_mtok: 0 }); });
it("seeds exact character-priced TTS without replacing owner routes", async () => { const c = await audioModelConfig("f", "audiobook.narrate"); expect(c.route.primary_model).toBe("tts-1-hd"); expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ model: "tts-1-hd", input_usd_per_mtok: 30 }), expect.objectContaining({ ignoreDuplicates: true })); expect(audioReservation(c, "а".repeat(1000), true)).toBe(0.033); });
it("rejects different providers, fallback, token-priced TTS, missing and invalid prices", async () => {
  for (const changes of [{ primary_provider: "anthropic" }, { fallback_model: "x" }, { primary_model: "gpt-4o-mini-tts" }]) { f.route.mockResolvedValueOnce({ data: { primary_provider: "openai", primary_model: "tts-1-hd", params: { max_tokens: 1 }, ...changes } }); await expect(audioModelConfig("f", "audiobook.narrate")).rejects.toThrow(); }
  f.price.mockResolvedValueOnce({ input_usd_per_mtok: NaN, output_usd_per_mtok: 0 }); await expect(audioModelConfig("f", "audiobook.narrate")).rejects.toThrow();
});
it("uses the validated price/route snapshot and exact text; refuses silent truncation", async () => {
  const config = await audioModelConfig("f", "audiobook.narrate"); await narrateAudio("f", "id", "Текст книги", "nova", config);
  const args = f.call.mock.calls[0]!; expect(args[1]).toEqual({ text: "Текст книги", voiceId: "nova" }); expect(await args[3].loadRoute()).toBe(config.route); expect(await args[3].loadPrice()).toBe(config.rates);
  await expect(narrateAudio("f", "id", "а".repeat(2801), "nova", config)).rejects.toThrow();
});

it("separates lesson-script adaptation from verbatim book editing under the validated OpenAI route", async () => {
  f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: 10000 } } }); f.price.mockResolvedValue({ input_usd_per_mtok: 2.5, output_usd_per_mtok: 15 });
  const config = await audioModelConfig("f", "audiobook.lesson_script");
  await prepareAudioText("f", "id", "Готовий навчальний матеріал", config, true);
  expect(f.call.mock.calls[0]![0]).toBe("audiobook.lesson_script"); expect(f.call.mock.calls[0]![1].system).toBe(audioLessonSystem);
  await prepareAudioText("f", "id", "Дослівний художній текст", config);
  expect(f.call.mock.calls[1]![0]).toBe("audiobook.prepare"); expect(f.call.mock.calls[1]![1].system).toBe(audioEditorialSystem);
});
