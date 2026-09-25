import "server-only";
import { forFamily } from "../db/family-scope";
import { notifyParent } from "../notifications";
import { createServiceClient } from "../supabase/clients";
import type { BudgetState, CallRecord, ModelPrice, ModelRoute } from "./types";

/**
 * Database side of the router: routes (cached 30 s, ADR-004), prices, budget
 * state and the atomic "record call + increment month" RPC (ADR-012).
 */
const ROUTE_TTL_MS = 30_000;
const PRICE_TTL_MS = 5 * 60_000;
const routeCache = new Map<string, { at: number; route: ModelRoute | null }>();
const priceCache = new Map<string, { at: number; price: ModelPrice | null }>();

export async function loadRoute(familyId: string, role: string): Promise<ModelRoute | null> {
  const key = `${familyId}:${role}`;
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.route;
  const { data, error } = await forFamily(familyId)
    .select(
      "model_routes",
      "role, primary_provider, primary_model, fallback_provider, fallback_model, escalation_provider, escalation_model, economy_provider, economy_model, params",
    )
    .eq("role", role)
    .maybeSingle<ModelRoute>();
  if (error) throw new Error(`loadRoute failed: ${error.message}`);
  const route = data ? { ...data, params: data.params ?? {} } : null;
  routeCache.set(key, { at: Date.now(), route });
  return route;
}

export async function loadPrice(provider: string, model: string): Promise<ModelPrice | null> {
  const key = `${provider}:${model}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  const { data } = await createServiceClient()
    .from("model_prices")
    .select("input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, cache_write_usd_per_mtok")
    .eq("provider", provider)
    .eq("model", model)
    .maybeSingle<Record<keyof ModelPrice, string | number | null>>();
  const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));
  const price = data
    ? {
        input_usd_per_mtok: num(data.input_usd_per_mtok) ?? 0,
        output_usd_per_mtok: num(data.output_usd_per_mtok) ?? 0,
        cache_read_usd_per_mtok: num(data.cache_read_usd_per_mtok),
        cache_write_usd_per_mtok: num(data.cache_write_usd_per_mtok),
      }
    : null;
  priceCache.set(key, { at: Date.now(), price });
  return price;
}

export interface BudgetSnapshot {
  month: string;
  state: BudgetState;
  spentUsd: number;
  limitUsd: number;
}

export async function getBudget(familyId: string): Promise<BudgetSnapshot> {
  const { data, error } = await createServiceClient()
    .rpc("get_budget_state", { p_family_id: familyId })
    .single<{ month: string; state: BudgetState; spent_usd: string; limit_usd: string }>();
  if (error || !data) throw new Error(`get_budget_state failed: ${error?.message ?? "no row"}`);
  return { month: data.month, state: data.state, spentUsd: Number(data.spent_usd), limitUsd: Number(data.limit_usd) };
}

export async function getBudgetState(familyId: string): Promise<BudgetState> {
  return (await getBudget(familyId)).state;
}

export async function recordCall(familyId: string, call: CallRecord): Promise<void> {
  const { error } = await createServiceClient().rpc("record_ai_call", { p_family_id: familyId, p_call: call });
  // Never lose the answer because logging failed, but make it visible.
  if (error) console.error(`record_ai_call failed: ${error.message}`);
}

export async function notifyFallback(familyId: string, role: string, from: string, to: string): Promise<void> {
  await notifyParent(familyId, { type: "provider_fallback", severity: "normal", payload: { role, from, to } }).catch(
    (e: Error) => console.error(`provider_fallback notification failed: ${e.message}`),
  );
}
