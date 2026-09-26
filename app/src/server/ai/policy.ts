import type { BudgetState, CallContext, ModelPrice, ModelRef, ModelRoute, Usage } from "./types";

/**
 * Pure routing and cost rules (docs/02 6.2, ADR-012). No I/O — unit-tested.
 */

/**
 * Roles that ignore the budget entirely (NFR-SAFE-13, A-P5). `lesson_review`
 * joins this set per NFR-COST-12 / US-6.11 КП-4 (D-55, ADR-022): the
 * independent review itself is never skipped or downgraded to an economy
 * model by budget mode — only the *revision* call (`lesson_generation`, run
 * again after a "revise" verdict) may use its route's economy model.
 */
export const BUDGET_EXEMPT_ROLES = new Set(["safety_moderator", "lesson_review"]);

export type ModelChoice =
  | { ok: true; model: ModelRef; tier: "primary" | "economy" | "escalation" }
  | { ok: false; reason: "hard_stop" | "deferred" };

export function selectModel(route: ModelRoute, state: BudgetState, ctx: Pick<CallContext, "escalate" | "sessionStartedBeforeBudget">): ModelChoice {
  const primary: ModelRef = { provider: route.primary_provider, model: route.primary_model };
  if (BUDGET_EXEMPT_ROLES.has(route.role)) return { ok: true, model: primary, tier: "primary" };

  if (state === "hard_stop") return { ok: false, reason: "hard_stop" };

  if (state === "budget" && !ctx.sessionStartedBeforeBudget) {
    if (route.economy_provider && route.economy_model) {
      return { ok: true, model: { provider: route.economy_provider, model: route.economy_model }, tier: "economy" };
    }
    if (route.params.budget_policy === "defer") return { ok: false, reason: "deferred" };
    return { ok: true, model: primary, tier: "primary" };
  }

  // No escalation in budget mode (ADR-012); otherwise on request (US-13.3).
  if (ctx.escalate && state !== "budget" && route.escalation_provider && route.escalation_model) {
    return {
      ok: true,
      model: { provider: route.escalation_provider, model: route.escalation_model },
      tier: "escalation",
    };
  }
  return { ok: true, model: primary, tier: "primary" };
}

export function fallbackOf(route: ModelRoute, used: ModelRef): ModelRef | null {
  if (!route.fallback_provider || !route.fallback_model) return null;
  const fb = { provider: route.fallback_provider, model: route.fallback_model };
  return fb.provider === used.provider && fb.model === used.model ? null : fb;
}

/** Estimated USD cost of one call; unknown price → 0 (and the caller logs it). */
export function estimateCostUsd(price: ModelPrice | null, usage: Usage): number {
  if (!price) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const cacheRead = price.cache_read_usd_per_mtok ?? price.input_usd_per_mtok;
  const cacheWrite = price.cache_write_usd_per_mtok ?? price.input_usd_per_mtok * 1.25;
  const usd =
    usage.inputTokens * price.input_usd_per_mtok +
    cached * cacheRead +
    written * cacheWrite +
    usage.outputTokens * price.output_usd_per_mtok;
  return Math.round((usd / 1_000_000) * 1e6) / 1e6;
}
