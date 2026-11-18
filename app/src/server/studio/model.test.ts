import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
const f = vi.hoisted(() => ({ upsert: vi.fn(), route: vi.fn(), price: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: () => ({ upsert: f.upsert }) }) }));
vi.mock("@/server/ai/store", () => ({ loadPrice: f.price }));
vi.mock("@/server/ai/router", () => ({ callStructured: vi.fn(), defaultRouterDeps: { providers: { structured: {} } } }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => ({ eq: () => ({ maybeSingle: f.route }) }) }) }));
import { callStructured } from "@/server/ai/router";
import { callStudioModel, studioModelConfig, studioReservation } from "./model";
beforeEach(() => { vi.clearAllMocks(); f.upsert.mockResolvedValue({ error: null }); f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: 16000, effort: "medium", timeout_ms: 120000, budget_policy: "defer" } } }); f.price.mockResolvedValue({ input_usd_per_mtok: 2.5, output_usd_per_mtok: 15 }); });
it("creates bounded budgeted OpenAI roles without overwriting parent overrides", async () => {
  await studioModelConfig("family", "studio.author"); expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ family_id: "family", role: "studio.author_full", params: expect.objectContaining({ budget_policy: "defer", max_tokens: 16000, effort: "medium" }) }), expect.objectContaining({ ignoreDuplicates: true }));
});
it("rejects fallback/economy providers, unbounded output and unknown prices before reserving or paying", async () => {
  f.route.mockResolvedValue({ data: { primary_provider: "openai", fallback_model: "other", params: { max_tokens: 12000 } } }); await expect(studioModelConfig("family", "studio.author")).rejects.toThrow();
  f.route.mockResolvedValue({ data: { primary_provider: "openai", params: { max_tokens: 90000 } } }); await expect(studioModelConfig("family", "studio.author")).rejects.toThrow();
  f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: 16000 } } });
  f.price.mockResolvedValue(null); await expect(studioModelConfig("family", "studio.author")).rejects.toThrow("price_missing");
});
it("reserves for UTF-8 input, schema, overhead and the output limit instead of guessing a free call", () => {
  const reserve = studioReservation("Правила", "Сторінка ".repeat(1000), z.object({ answer: z.string() }), 12000, { input_usd_per_mtok: 2.5, output_usd_per_mtok: 15 });
  expect(reserve).toBeGreaterThan(12000 * 15 / 1000000); expect(reserve).toBeLessThan(1);
});

it("passes the validated route and prices to the router instead of cached configuration", async () => {
  const config = await studioModelConfig("family", "studio.author");
  vi.mocked(callStructured).mockResolvedValueOnce({ result: { result: { text: "Lesson" } }, model: { provider: "openai", model: "gpt-5.4" }, costUsd: 0.01, fallbackUsed: false });
  await callStudioModel("family", "project", "studio.author", "Rules", "Lesson", z.object({ text: z.string() }), config);
  const deps = vi.mocked(callStructured).mock.calls[0]![3]!;
  expect(await deps.loadRoute("family", "studio.author")).toBe(config.route);
  expect(await deps.loadPrice("openai", "gpt-5.4")).toBe(config.rates);
});

it("upgrades only the known low-effort seed into a separate quality route", async () => {
 const old={primary_provider:"openai",primary_model:"gpt-5.4",params:{max_tokens:12000,effort:"low",timeout_ms:120000,budget_policy:"defer"}};
 f.route.mockResolvedValueOnce({data:old}); await studioModelConfig("family","studio.author");
 expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({role:"studio.author_full",params:expect.objectContaining({max_tokens:16000,effort:"medium"})}),expect.objectContaining({ignoreDuplicates:true})); expect(old.params.max_tokens).toBe(12000);
});
it("inherits explicit parent model parameters without overwriting either route", async () => {
 const custom={primary_provider:"openai",primary_model:"gpt-5.4",params:{max_tokens:9000,effort:"high",timeout_ms:100000,budget_policy:"defer"}};
 f.route.mockResolvedValue({data:custom}); const result=await studioModelConfig("family","studio.author");
 expect(result.route.params).toEqual(custom.params); expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({role:"studio.author_full",params:custom.params}),expect.objectContaining({ignoreDuplicates:true}));
});
it("allows a full author response more time while preserving the source timeout", async () => {
  expect((await studioModelConfig("family", "studio.author")).route.params.timeout_ms).toBe(210000);
  expect((await studioModelConfig("family", "studio.source")).route.params.timeout_ms).toBe(120000);
});

it.each([
  ["studio.source", "GEMINI_API_KEY", "gemini", "gemini-3.1-flash-lite", 8000],
  ["studio.review", "ANTHROPIC_API_KEY", "anthropic", "claude-sonnet-5", 8000],
] as const)("assigns %s to its connected specialist and separately prices recovery", async (role, key, provider, model, max_tokens) => {
  vi.stubEnv(key, "test");
  try {
    f.route.mockResolvedValue({data: {primary_provider:"openai",primary_model:"gpt-5.4",params:{max_tokens,effort:"medium",timeout_ms:120000,budget_policy:"defer"}}});
    expect((await studioModelConfig("family", role)).route.primary_provider).toBe(provider);
    expect(f.price).toHaveBeenCalledWith(provider, model);
    expect((await studioModelConfig("family", role, true)).route.primary_provider).toBe("openai");
  } finally { vi.unstubAllEnvs(); }
});
