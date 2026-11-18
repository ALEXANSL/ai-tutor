import "server-only";
import { z } from "zod";
import { callStructured, defaultRouterDeps } from "@/server/ai/router";
import { loadPrice } from "@/server/ai/store";
import { AiNotConfiguredError, type ModelRoute } from "@/server/ai/types";
import { createServiceClient } from "@/server/supabase/clients";
import { forFamily } from "@/server/db/family-scope";
export type StudioRole = "studio.resolve" | "studio.assess" | "studio.source" | "studio.plan" | "studio.author" | "studio.design" | "studio.review" | "studio.repair";
const OUTPUT: Record<StudioRole, number> = { "studio.resolve": 6000, "studio.assess": 4000, "studio.source": 8000, "studio.plan": 6000, "studio.author": 16000, "studio.design": 5000, "studio.review": 8000, "studio.repair": 6000 };
const OLD_OUTPUT: Record<StudioRole, number> = { "studio.resolve": 6000, "studio.assess": 4000, "studio.source": 8000, "studio.plan": 4500, "studio.author": 12000, "studio.design": 5000, "studio.review": 6000, "studio.repair": 6000 };
export function studioRouteRole(role: StudioRole) { return ["studio.plan", "studio.author", "studio.review"].includes(role) ? `${role}_full` : role; }
export async function studioModelConfig(familyId: string, role: StudioRole) {
  const db = createServiceClient();
  const price = await db.from("model_prices").upsert({ provider: "openai", model: "gpt-5.4", input_usd_per_mtok: 2.5, output_usd_per_mtok: 15, cache_read_usd_per_mtok: 0.25, notes: "GPT-5.4 <=272K tokens; verified official model page 2026-11-09; preserve owner overrides." }, { onConflict: "provider,model", ignoreDuplicates: true });
  if (price.error) throw new AiNotConfiguredError("studio_price");
  const routingRole = studioRouteRole(role);
  const legacy = routingRole !== role ? await forFamily(familyId).select("model_routes", "*").eq("role", role).maybeSingle<ModelRoute>() : { data: null, error: null };
  if (legacy.error) throw new AiNotConfiguredError("studio_route_read");
  const old = legacy.data;
  const knownDefault = old?.primary_provider === "openai" && old.primary_model === "gpt-5.4" && old.params?.max_tokens === OLD_OUTPUT[role] && old.params.effort === "low" && old.params.timeout_ms === 120000 && old.params.budget_policy === "defer" && !old.fallback_model && !old.economy_model && !old.escalation_model && Object.keys(old.params).every(key => ["max_tokens", "effort", "timeout_ms", "budget_policy"].includes(key));
  const inherited = old && !knownDefault ? { primary_provider: old.primary_provider, primary_model: old.primary_model, fallback_provider: old.fallback_provider, fallback_model: old.fallback_model, economy_provider: old.economy_provider, economy_model: old.economy_model, escalation_provider: old.escalation_provider, escalation_model: old.escalation_model, params: old.params } : { primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: OUTPUT[role], effort: role === "studio.design" ? "low" : "medium", timeout_ms: 120000, budget_policy: "defer" } };
  const saved = await db.from("model_routes").upsert({ family_id: familyId, role: routingRole, ...inherited }, { onConflict: "family_id,role", ignoreDuplicates: true });
  if (saved.error) throw new AiNotConfiguredError("studio_route");
  const { data: route, error } = await forFamily(familyId).select("model_routes", "*").eq("role", routingRole).maybeSingle<ModelRoute>();
  if (error || !route || route.primary_provider !== "openai" || route.fallback_model || route.economy_model || route.escalation_model || !Number.isSafeInteger(route.params.max_tokens) || (route.params.max_tokens ?? 0) < 1 || (route.params.max_tokens ?? 0) > 16000 || (route.params.timeout_ms ?? 120000) > 120000) throw new AiNotConfiguredError("studio_route_must_be_bounded_openai");
  const rates = await loadPrice("openai", route.primary_model);
  if (!rates || !Number.isFinite(rates.input_usd_per_mtok) || !Number.isFinite(rates.output_usd_per_mtok) || rates.input_usd_per_mtok <= 0 || rates.output_usd_per_mtok <= 0) throw new AiNotConfiguredError("studio_price_missing");
  return { route: { ...route, role: routingRole }, rates };
}
export function studioReservation(system: string, prompt: string, schema: z.ZodType, maxTokens: number, rates: { input_usd_per_mtok: number; output_usd_per_mtok: number }) {
  // UTF-8 bytes are a conservative token bound, including schema + protocol overhead.
  const input = Buffer.byteLength(system + prompt + JSON.stringify(z.toJSONSchema(schema))) + 4096;
  return Math.ceil((input * rates.input_usd_per_mtok + maxTokens * rates.output_usd_per_mtok) / 1_000_000 * 1.2 * 10000) / 10000;
}
export async function callStudioModel<S extends z.ZodType>(familyId: string, projectId: string, role: StudioRole, system: string, prompt: string, schema: S, config: Awaited<ReturnType<typeof studioModelConfig>>) {
  // Use the exact validated and reserved route/rates, never a stale router cache.
  return callStructured(config.route.role, { system, prompt, schema }, { familyId, ref: { table: "jobs", id: projectId } }, { ...defaultRouterDeps, loadRoute: async () => config.route, loadPrice: async () => config.rates });
}
