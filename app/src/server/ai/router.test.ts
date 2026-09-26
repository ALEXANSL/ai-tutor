import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { estimateCostUsd, fallbackOf, selectModel } from "./policy";
import { callStructured, callVisionStructured, embedTexts, type RouterDeps } from "./router";
import { BudgetBlockedError, ProviderError, type CallRecord, type ModelRoute } from "./types";

const route = (over: Partial<ModelRoute> = {}): ModelRoute => ({
  role: "indexing_structure",
  primary_provider: "anthropic",
  primary_model: "claude-opus-5-5",
  fallback_provider: null,
  fallback_model: null,
  escalation_provider: null,
  escalation_model: null,
  economy_provider: null,
  economy_model: null,
  params: { budget_policy: "defer" },
  ...over,
});

describe("selectModel (docs/02 6.2)", () => {
  it("uses the primary model in normal and warned states", () => {
    for (const s of ["normal", "warned"] as const) {
      expect(selectModel(route(), s, {})).toEqual({
        ok: true,
        model: { provider: "anthropic", model: "claude-opus-5-5" },
        tier: "primary",
      });
    }
  });

  it("blocks everything but safety at 110 %", () => {
    expect(selectModel(route(), "hard_stop", {})).toEqual({ ok: false, reason: "hard_stop" });
    expect(selectModel(route({ role: "safety_moderator" }), "hard_stop", {}).ok).toBe(true);
  });

  it("defers indexing in budget mode (US-11.5 KP-6, US-2.6 KP-5)", () => {
    expect(selectModel(route(), "budget", {})).toEqual({ ok: false, reason: "deferred" });
  });

  it("switches to the economy model in budget mode, but lets a running session finish", () => {
    const r = route({ economy_provider: "google", economy_model: "eco", params: {} });
    expect(selectModel(r, "budget", {})).toMatchObject({ tier: "economy", model: { model: "eco" } });
    expect(selectModel(r, "budget", { sessionStartedBeforeBudget: true })).toMatchObject({ tier: "primary" });
  });

  it("uses primary in budget mode when the policy is 'primary' and there is no economy model", () => {
    expect(selectModel(route({ params: { budget_policy: "primary" } }), "budget", {})).toMatchObject({
      tier: "primary",
    });
  });

  it("escalates only on request and never in budget mode", () => {
    const r = route({ escalation_provider: "anthropic", escalation_model: "big", params: {} });
    expect(selectModel(r, "normal", { escalate: true })).toMatchObject({ tier: "escalation" });
    expect(selectModel(r, "budget", { escalate: true })).toMatchObject({ tier: "primary" });
  });

  it("has no fallback when it is missing or identical", () => {
    expect(fallbackOf(route(), { provider: "anthropic", model: "claude-opus-5-5" })).toBeNull();
    const r = route({ fallback_provider: "anthropic", fallback_model: "claude-opus-5-5" });
    expect(fallbackOf(r, { provider: "anthropic", model: "claude-opus-5-5" })).toBeNull();
  });
});

describe("estimateCostUsd (ADR-012)", () => {
  const opus = { input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_read_usd_per_mtok: 0.2, cache_write_usd_per_mtok: null };

  it("prices input, output and cached tokens", () => {
    expect(estimateCostUsd(opus, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
    expect(estimateCostUsd(opus, { inputTokens: 50_000, outputTokens: 5_000 })).toBeCloseTo(0.3, 6);
    expect(estimateCostUsd(opus, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 })).toBeCloseTo(0.2);
    // cache writes default to 1.25 × input
    expect(estimateCostUsd(opus, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(5);
  });

  it("prices embeddings", () => {
    const emb = { input_usd_per_mtok: 0.13, output_usd_per_mtok: 0, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null };
    expect(estimateCostUsd(emb, { inputTokens: 200_000, outputTokens: 0 })).toBeCloseTo(0.026, 6);
  });

  it("returns 0 when the price is unknown", () => {
    expect(estimateCostUsd(null, { inputTokens: 5, outputTokens: 5 })).toBe(0);
  });
});

function deps(over: Partial<RouterDeps> = {}): RouterDeps & { calls: CallRecord[]; fallbacks: string[] } {
  const calls: CallRecord[] = [];
  const fallbacks: string[] = [];
  let t = 1000;
  return {
    calls,
    fallbacks,
    loadRoute: async (_f, role) => route({ role, params: {} }),
    getBudgetState: async () => "normal",
    loadPrice: async () => ({ input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null }),
    recordCall: async (_f, c) => {
      calls.push(c);
    },
    notifyFallback: async (_f, role, from, to) => {
      fallbacks.push(`${role}:${from}->${to}`);
    },
    providers: {
      structured: {
        anthropic: async () => ({ data: { ok: true }, usage: { inputTokens: 1000, outputTokens: 100 } }),
      },
      embed: {
        openai: async ({ texts }) => ({ vectors: texts.map(() => [0.1, 0.2]), usage: { inputTokens: 10, outputTokens: 0 } }),
      },
      vision: {
        anthropic: async () => ({ data: { ok: true }, usage: { inputTokens: 1000, outputTokens: 100 } }),
      },
    },
    now: () => (t += 50),
    ...over,
  };
}

const schema = z.object({ ok: z.boolean() });
const ctx = { familyId: "fam-1", ref: { table: "materials", id: "00000000-0000-0000-0000-000000000001" } };

describe("callStructured / embedTexts (router)", () => {
  it("records role, model, tokens, cost and the ref of every call (NFR-COST-4)", async () => {
    const d = deps();
    const res = await callStructured("indexing_structure", { system: "s", prompt: "p", schema }, ctx, d);
    expect(res.result).toEqual({ ok: true });
    expect(res.costUsd).toBeCloseTo(0.006, 6);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({
      role: "indexing_structure",
      provider: "anthropic",
      model: "claude-opus-5-5",
      status: "ok",
      input_tokens: 1000,
      output_tokens: 100,
      ref_table: "materials",
      fallback_used: false,
    });
    expect(d.calls[0]!.latency_ms).toBeGreaterThan(0);
  });

  it("falls back to the reserve provider, records both calls and tells the parent (US-13.2)", async () => {
    const d = deps({
      loadRoute: async (_f, role) =>
        route({ role, params: {}, fallback_provider: "backup", fallback_model: "backup-model" }),
    });
    d.providers.structured.anthropic = async () => {
      throw new ProviderError("anthropic error 529", "anthropic", 529, true);
    };
    d.providers.structured.backup = async () => ({ data: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } });
    const res = await callStructured("indexing_structure", { system: "s", prompt: "p", schema }, ctx, d);
    expect(res.fallbackUsed).toBe(true);
    expect(d.calls.map((c) => [c.model, c.status])).toEqual([
      ["claude-opus-5-5", "error"],
      ["backup-model", "ok"],
    ]);
    expect(d.fallbacks).toEqual(["indexing_structure:claude-opus-5-5->backup-model"]);
  });

  it("throws the provider error when there is no fallback", async () => {
    const d = deps();
    d.providers.structured.anthropic = async () => {
      throw new ProviderError("boom", "anthropic", 500, true);
    };
    await expect(callStructured("x", { system: "s", prompt: "p", schema }, ctx, d)).rejects.toBeInstanceOf(ProviderError);
    expect(d.calls[0]).toMatchObject({ status: "error", cost_usd: 0 });
  });

  it("refuses deferred calls in budget mode without calling the provider", async () => {
    const provider = vi.fn();
    const d = deps({
      getBudgetState: async () => "budget",
      loadRoute: async (_f, role) => route({ role, params: { budget_policy: "defer" } }),
    });
    d.providers.structured.anthropic = provider;
    await expect(callStructured("indexing_structure", { system: "s", prompt: "p", schema }, ctx, d)).rejects.toBeInstanceOf(
      BudgetBlockedError,
    );
    expect(provider).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
  });

  it("embeds a batch through the embeddings route", async () => {
    const d = deps({
      loadRoute: async () =>
        route({ role: "embeddings", primary_provider: "openai", primary_model: "text-embedding-3-large", params: { dimensions: 1536 } }),
    });
    const res = await embedTexts(["a", "b"], ctx, d);
    expect(res.result).toHaveLength(2);
    expect(d.calls[0]).toMatchObject({ role: "embeddings", provider: "openai", input_tokens: 10 });
  });

  it("fails clearly when the role has no route", async () => {
    const d = deps({ loadRoute: async () => null });
    await expect(embedTexts(["a"], ctx, d)).rejects.toThrow(/no model route/);
  });

  it("calls the vision provider with the documents and records the call under its own role (D-54 ocr_page)", async () => {
    const d = deps({ loadRoute: async () => route({ role: "ocr_page", primary_provider: "anthropic", primary_model: "claude-sonnet-5", params: {} }) });
    const documents = [{ mediaType: "application/pdf" as const, data: "QkFTRTY0" }];
    const res = await callVisionStructured("ocr_page", { system: "s", prompt: "p", schema, documents }, ctx, d);
    expect(res.result).toEqual({ ok: true });
    expect(d.calls[0]).toMatchObject({ role: "ocr_page", provider: "anthropic", model: "claude-sonnet-5" });
  });
});
