import "server-only";
import { z } from "zod";
import { callStructured, defaultRouterDeps } from "@/server/ai/router";
import { loadPrice } from "@/server/ai/store";
import { AiNotConfiguredError, type ModelRoute } from "@/server/ai/types";
import { createServiceClient } from "@/server/supabase/clients";
import { forFamily } from "@/server/db/family-scope";
export type StudioRole = "studio.plan" | "studio.author" | "studio.design" | "studio.review";
const OUTPUT: Record<StudioRole, number> = { "studio.plan": 4500, "studio.author": 12000, "studio.design": 5000, "studio.review": 6000 };
export async function studioModelConfig(familyId: string, role: StudioRole) {
  const db = createServiceClient();
  const price = await db.from("model_prices").upsert({ provider: "openai", model: "gpt-5.4", input_usd_per_mtok: 2.5, output_usd_per_mtok: 15, cache_read_usd_per_mtok: 0.25, notes: "GPT-5.4 <=272K tokens; verified official model page 2026-11-09; preserve owner overrides." }, { onConflict: "provider,model", ignoreDuplicates: true });
  if (price.error) throw new AiNotConfiguredError("studio_price");
  const saved = await db.from("model_routes").upsert({ family_id: familyId, role, primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: OUTPUT[role], effort: "low", timeout_ms: 120000, budget_policy: "defer" } }, { onConflict: "family_id,role", ignoreDuplicates: true });
  if (saved.error) throw new AiNotConfiguredError("studio_route");
  const { data: route, error } = await forFamily(familyId).select("model_routes", "*").eq("role", role).maybeSingle<ModelRoute>();
  if (error || !route || route.primary_provider !== "openai" || route.fallback_model || route.economy_model || route.escalation_model || !Number.isSafeInteger(route.params.max_tokens) || (route.params.max_tokens ?? 0) < 1 || (route.params.max_tokens ?? 0) > 16000 || (route.params.timeout_ms ?? 120000) > 120000) throw new AiNotConfiguredError("studio_route_must_be_bounded_openai");
  const rates = await loadPrice("openai", route.primary_model);
  if (!rates || !Number.isFinite(rates.input_usd_per_mtok) || !Number.isFinite(rates.output_usd_per_mtok) || rates.input_usd_per_mtok <= 0 || rates.output_usd_per_mtok <= 0) throw new AiNotConfiguredError("studio_price_missing");
  return { route, rates };
}
export function studioReservation(system: string, prompt: string, schema: z.ZodType, maxTokens: number, rates: { input_usd_per_mtok: number; output_usd_per_mtok: number }) {
  // UTF-8 bytes are a conservative token bound, including schema + protocol overhead.
  const input = Buffer.byteLength(system + prompt + JSON.stringify(z.toJSONSchema(schema))) + 4096;
  return Math.ceil((input * rates.input_usd_per_mtok + maxTokens * rates.output_usd_per_mtok) / 1_000_000 * 1.2 * 10000) / 10000;
}
export async function callStudioModel<S extends z.ZodType>(familyId: string, projectId: string, role: StudioRole, system: string, prompt: string, schema: S, config: Awaited<ReturnType<typeof studioModelConfig>>) {
  // Use the exact validated and reserved route/rates, never a stale router cache.
  return callStructured(role, { system, prompt, schema }, { familyId, ref: { table: "jobs", id: projectId } }, { ...defaultRouterDeps, loadRoute: async () => config.route, loadPrice: async () => config.rates });
}
