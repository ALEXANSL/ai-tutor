import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
const f = vi.hoisted(() => ({ upsert: vi.fn(), route: vi.fn(), price: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: () => ({ upsert: f.upsert }) }) }));
vi.mock("@/server/ai/store", () => ({ loadPrice: f.price }));
vi.mock("@/server/ai/router", () => ({ callStructured: vi.fn(), defaultRouterDeps: {} }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => ({ eq: () => ({ maybeSingle: f.route }) }) }) }));
import { callStructured } from "@/server/ai/router";
import { callStudioModel, studioModelConfig, studioReservation } from "./model";
beforeEach(() => { vi.clearAllMocks(); f.upsert.mockResolvedValue({ error: null }); f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: 12000, timeout_ms: 120000 } } }); f.price.mockResolvedValue({ input_usd_per_mtok: 2.5, output_usd_per_mtok: 15 }); });
it("creates bounded budgeted OpenAI roles without overwriting parent overrides", async () => {
  await studioModelConfig("family", "studio.author"); expect(f.upsert).toHaveBeenCalledWith(expect.objectContaining({ family_id: "family", role: "studio.author", params: expect.objectContaining({ budget_policy: "defer", max_tokens: 12000 }) }), expect.objectContaining({ ignoreDuplicates: true }));
});
it("rejects fallback/economy providers, unbounded output and unknown prices before reserving or paying", async () => {
  f.route.mockResolvedValueOnce({ data: { primary_provider: "openai", fallback_model: "other", params: { max_tokens: 12000 } } }); await expect(studioModelConfig("family", "studio.author")).rejects.toThrow();
  f.route.mockResolvedValueOnce({ data: { primary_provider: "openai", params: { max_tokens: 90000 } } }); await expect(studioModelConfig("family", "studio.author")).rejects.toThrow();
  f.price.mockResolvedValue(null); await expect(studioModelConfig("family", "studio.author")).rejects.toThrow("price_missing");
});
it("reserves for UTF-8 input, schema, overhead and the output limit instead of guessing a free call", () => {
  const reserve = studioReservation("Правила", "Сторінка ".repeat(1000), z.object({ answer: z.string() }), 12000, { input_usd_per_mtok: 2.5, output_usd_per_mtok: 15 });
  expect(reserve).toBeGreaterThan(12000 * 15 / 1000000); expect(reserve).toBeLessThan(1);
});

it("passes the validated route and prices to the router instead of cached configuration", async () => {
  const config = await studioModelConfig("family", "studio.author");
  await callStudioModel("family", "project", "studio.author", "Rules", "Lesson", z.object({ text: z.string() }), config);
  const deps = vi.mocked(callStructured).mock.calls[0]![3]!;
  expect(await deps.loadRoute("family", "studio.author")).toBe(config.route);
  expect(await deps.loadPrice("openai", "gpt-5.4")).toBe(config.rates);
});
