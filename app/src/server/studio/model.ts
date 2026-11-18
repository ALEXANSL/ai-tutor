import "server-only";
import { geminiKey, geminiStudio } from "./gemini";
import { getServerSecret } from "@/server/env";
import { z } from "zod";
import { openaiStructuredCaptured, type OpenAiCapturedResult } from "@/server/ai/providers/openai";
import { callStructured, defaultRouterDeps } from "@/server/ai/router";
import { loadPrice } from "@/server/ai/store";
import { AiNotConfiguredError, type ModelRoute } from "@/server/ai/types";
import { createServiceClient } from "@/server/supabase/clients";
import { forFamily } from "@/server/db/family-scope";
export type StudioRole = "studio.resolve" | "studio.assess" | "studio.source" | "studio.plan" | "studio.author" | "studio.design" | "studio.review" | "studio.repair";
const OUTPUT: Record<StudioRole, number> = { "studio.resolve": 6000, "studio.assess": 4000, "studio.source": 8000, "studio.plan": 6000, "studio.author": 16000, "studio.design": 5000, "studio.review": 8000, "studio.repair": 6000 };
const OLD_OUTPUT: Record<StudioRole, number> = { "studio.resolve": 6000, "studio.assess": 4000, "studio.source": 8000, "studio.plan": 4500, "studio.author": 12000, "studio.design": 5000, "studio.review": 6000, "studio.repair": 6000 };
export function studioRouteRole(role: StudioRole) { return ["studio.plan", "studio.author", "studio.review"].includes(role) ? `${role}_full` : role; }
export async function studioModelConfig(familyId: string, role: StudioRole, useDefault = false) {
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
  if (error || !route || !["openai","anthropic","gemini"].includes(route.primary_provider) || route.fallback_model || route.economy_model || route.escalation_model || !Number.isSafeInteger(route.params.max_tokens) || (route.params.max_tokens ?? 0) < 1 || (route.params.max_tokens ?? 0) > 16000 || (route.params.timeout_ms ?? 120000) > 120000) throw new AiNotConfiguredError("studio_route_must_be_bounded");
  const standard = route.primary_provider === "openai" && route.primary_model === "gpt-5.4"
    && route.params.timeout_ms === 120000 && route.params.budget_policy === "defer"
    && ((route.params.max_tokens === OUTPUT[role] && route.params.effort === (role === "studio.design" ? "low" : "medium"))
      || (route.params.max_tokens === OLD_OUTPUT[role] && route.params.effort === "low"))
    && Object.keys(route.params).every(key => ["max_tokens","effort","timeout_ms","budget_policy"].includes(key));
  let selected = route;
  if (!useDefault && standard && role === "studio.review" && getServerSecret("ANTHROPIC_API_KEY")) {
    selected = { ...route, primary_provider: "anthropic", primary_model: "claude-sonnet-5" };
  }
  if (!useDefault && standard && ["studio.source", "studio.design"].includes(role) && geminiKey()) {
    selected = { ...route, primary_provider: "gemini", primary_model: "gemini-3.1-flash-lite" };
    const price = await db.from("model_prices").upsert({ provider: "gemini", model: selected.primary_model, input_usd_per_mtok: 0.25, output_usd_per_mtok: 1.5, notes: "Workshop source and design, docs/03." }, { onConflict: "provider,model", ignoreDuplicates: true });
    if (price.error) throw new AiNotConfiguredError("studio_price");
  }
  const rates = await loadPrice(selected.primary_provider, selected.primary_model);
  if (!rates || !Number.isFinite(rates.input_usd_per_mtok) || !Number.isFinite(rates.output_usd_per_mtok) || rates.input_usd_per_mtok <= 0 || rates.output_usd_per_mtok <= 0) throw new AiNotConfiguredError("studio_price_missing");
  // Existing seeded author routes have a two-minute timeout. A complete lesson
  // has the largest output allowance and runs in a 300-second worker.
  const seededAuthor = role === "studio.author" && route.primary_model === "gpt-5.4"
    && route.params.max_tokens === OUTPUT[role] && route.params.effort === "medium"
    && route.params.timeout_ms === 120000 && route.params.budget_policy === "defer";
  const params = seededAuthor ? { ...route.params, timeout_ms: 210000 } : standard && role === "studio.repair" ? { ...route.params, effort: "low" as const, max_tokens: 12000 } : route.params;
  return { route: { ...selected, role: routingRole, params }, rates, specialist: selected !== route || undefined };
}
export function studioReservation(system: string, prompt: string, schema: z.ZodType, maxTokens: number, rates: { input_usd_per_mtok: number; output_usd_per_mtok: number }) {
  // UTF-8 bytes are a conservative token bound, including schema + protocol overhead.
  const input = Buffer.byteLength(system + prompt + JSON.stringify(z.toJSONSchema(schema))) + 4096;
  return Math.ceil((input * rates.input_usd_per_mtok + maxTokens * rates.output_usd_per_mtok) / 1_000_000 * 1.2 * 10000) / 10000;
}
export async function callStudioModel<S extends z.ZodType>(familyId: string, projectId: string, role: StudioRole, system: string, prompt: string, schema: S, config: Pick<Awaited<ReturnType<typeof studioModelConfig>>, "route" | "rates">) {
  // Use the exact validated and reserved route/rates, never a stale router cache.
  const captured = await callStructured(config.route.role, { system, prompt, schema }, { familyId, ref: { table: "jobs", id: projectId } }, { ...defaultRouterDeps, loadRoute: async () => config.route, loadPrice: async () => config.rates, providers: { ...defaultRouterDeps.providers, structured: { ...defaultRouterDeps.providers.structured, gemini: geminiStudio, openai: req => openaiStructuredCaptured(req, fetch, role === "studio.author") } } });
  if (captured.model.provider === "anthropic") return { ...captured, failure: undefined };
  const envelope = captured.result as OpenAiCapturedResult;
  return { ...captured, result: envelope.result, ...(envelope.failure ? { failure: envelope.failure } : {}) };
}
