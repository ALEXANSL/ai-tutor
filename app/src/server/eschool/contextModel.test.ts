import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelRoute } from "@/server/ai/types";
const f = vi.hoisted(() => ({ route: null as ModelRoute | null, upsert: vi.fn(), price: vi.fn(), call: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: () => ({ upsert: f.upsert }) }) }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: f.route, error: null }) }) }) }) }));
vi.mock("@/server/ai/store", () => ({ loadPrice: f.price }));
vi.mock("@/server/ai/router", () => ({ callStructured: f.call, defaultRouterDeps: {} }));
import { contextModelConfig, callContextModel } from "./contextModel";
beforeEach(() => { vi.clearAllMocks(); f.route = { role: "school.context_match", primary_provider: "openai", primary_model: "gpt-4.1-mini", fallback_provider: null, fallback_model: null, economy_provider: null, economy_model: null, escalation_provider: null, escalation_model: null, params: { max_tokens: 1200, timeout_ms: 30000, budget_policy: "defer" } }; f.upsert.mockResolvedValue({ error: null }); f.price.mockResolvedValue({ input_usd_per_mtok: 0.4, output_usd_per_mtok: 1.6 }); });
it("sets a bounded OpenAI route without replacing existing owner prices/routes", async () => {
  await contextModelConfig("family"); expect(f.upsert).toHaveBeenCalledTimes(2);
  expect(f.upsert.mock.calls.every(call => call[1].ignoreDuplicates)).toBe(true);
});
it.each(["provider", "fallback", "tokens", "timeout", "price"])("rejects an unsafe %s override", async kind => {
  if (kind === "provider") f.route!.primary_provider = "anthropic";
  if (kind === "fallback") f.route!.fallback_model = "expensive";
  if (kind === "tokens") f.route!.params.max_tokens = 32000;
  if (kind === "timeout") f.route!.params.timeout_ms = 300000;
  if (kind === "price") f.price.mockResolvedValue({ input_usd_per_mtok: NaN, output_usd_per_mtok: 1 });
  await expect(contextModelConfig("family")).rejects.toThrow();
});
it("uses exactly the validated route/rates, family accounting, and output schema", async () => {
  const config = await contextModelConfig("family"); f.call.mockResolvedValue({ result: { topicIds: ["a"] }, model: { provider: "openai" } });
  expect(await callContextModel("family", "job", { stage: "shortlist" }, z.object({ topicIds: z.array(z.string()) }), config)).toEqual({ topicIds: ["a"] });
  expect(f.call.mock.calls[0]![2]).toEqual({ familyId: "family", ref: { table: "jobs", id: "job" } });
  expect(await f.call.mock.calls[0]![3].loadRoute()).toBe(config.route);
});
