import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelRoute } from "@/server/ai/types";
const f = vi.hoisted(() => ({ record: vi.fn(), budget: vi.fn() }));
vi.mock("@/server/ai/store", () => ({ loadRoute: vi.fn(), loadPrice: vi.fn(), getBudgetState: f.budget, recordCall: f.record, notifyFallback: vi.fn() }));
import { callStudioModel } from "./model";
const route: ModelRoute = { role: "studio.source", primary_provider: "openai", primary_model: "test", fallback_provider: null, fallback_model: null, economy_provider: null, economy_model: null, escalation_provider: null, escalation_model: null, params: { max_tokens: 8000, budget_policy: "defer" } };
const config = { route, rates: { input_usd_per_mtok: 2.5, output_usd_per_mtok: 15, cache_read_usd_per_mtok: 0.25, cache_write_usd_per_mtok: null } };
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("OPENAI_API_KEY", "test-key"); f.budget.mockResolvedValue("normal"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(["completed", "incomplete"])("accounts real adapter/router usage before returning %s content to the receipt workflow", async status => {
 const fetcher = vi.fn(async () => Response.json({ status, output_text: status === "completed" ? '{"title":"Lesson"}' : '{"title":', usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 400 } } }));vi.stubGlobal("fetch", fetcher);
 const result = await callStudioModel("family", "project", "studio.source", "Rules", "Source", z.object({ title: z.string() }), config);
 expect(fetcher).toHaveBeenCalledTimes(1);expect(result.costUsd).toBe(0.0046);expect(result.failure?.code).toBe(status === "incomplete" ? "STUDIO-AI-INCOMPLETE" : undefined);
 expect(f.record).toHaveBeenCalledTimes(1);expect(f.record).toHaveBeenCalledWith("family", expect.objectContaining({ cost_usd: 0.0046, input_tokens: 600, output_tokens: 200, cached_input_tokens: 400, ref_id: "project" }));
});
it("retains provider timeout classification and never starts fallback or another request", async () => {
 const fetcher = vi.fn(async () => { throw new DOMException("private", "TimeoutError"); });vi.stubGlobal("fetch", fetcher);
 await expect(callStudioModel("family", "project", "studio.source", "Rules", "Source", z.object({ title: z.string() }), config)).rejects.toMatchObject({ code: "timeout" });expect(fetcher).toHaveBeenCalledTimes(1);expect(f.record).toHaveBeenCalledTimes(1);
});
