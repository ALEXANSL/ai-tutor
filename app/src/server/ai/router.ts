import "server-only";
import type { z } from "zod";
import { estimateCostUsd, fallbackOf, selectModel } from "./policy";
import { anthropicStructured } from "./providers/anthropic";
import { openaiEmbed } from "./providers/openai";
import * as store from "./store";
import {
  AiNotConfiguredError,
  BudgetBlockedError,
  ProviderError,
  type BudgetState,
  type CallContext,
  type CallRecord,
  type ModelPrice,
  type ModelRef,
  type ModelRoute,
  type RouteParams,
  type Usage,
} from "./types";

/**
 * Model router (docs/02 6, ADR-004). The ONLY way code calls an AI model:
 * role → model from `model_routes`, budget rules, fallback to the reserve
 * provider, and a cost record for every call (NFR-COST-4). Server-only.
 */

/** Provider adapters: adding a provider = adding an entry here (ADR-004). */
export interface ProviderAdapters {
  structured: Record<
    string,
    (req: { model: string; system: string; prompt: string; schema: z.ZodType; params: RouteParams }) => Promise<{
      data: unknown;
      usage: Usage;
    }>
  >;
  embed: Record<
    string,
    (req: { model: string; texts: string[]; dimensions?: number; timeoutMs?: number }) => Promise<{
      vectors: number[][];
      usage: Usage;
    }>
  >;
}

export interface RouterDeps {
  loadRoute(familyId: string, role: string): Promise<ModelRoute | null>;
  getBudgetState(familyId: string): Promise<BudgetState>;
  loadPrice(provider: string, model: string): Promise<ModelPrice | null>;
  recordCall(familyId: string, call: CallRecord): Promise<void>;
  notifyFallback(familyId: string, role: string, from: string, to: string): Promise<void>;
  providers: ProviderAdapters;
  now(): number;
}

export const defaultRouterDeps: RouterDeps = {
  loadRoute: store.loadRoute,
  getBudgetState: store.getBudgetState,
  loadPrice: store.loadPrice,
  recordCall: store.recordCall,
  notifyFallback: store.notifyFallback,
  providers: {
    structured: { anthropic: (req) => anthropicStructured(req) },
    embed: { openai: (req) => openaiEmbed(req) },
  },
  now: () => Date.now(),
};

export interface RoutedResult<T> {
  result: T;
  model: ModelRef;
  costUsd: number;
  fallbackUsed: boolean;
}

async function routed<T>(
  role: string,
  kind: keyof ProviderAdapters,
  ctx: CallContext,
  deps: RouterDeps,
  run: (model: ModelRef, params: RouteParams) => Promise<{ value: T; usage: Usage }>,
): Promise<RoutedResult<T>> {
  const route = await deps.loadRoute(ctx.familyId, role);
  if (!route) throw new AiNotConfiguredError(`no model route for role "${role}"`);
  const state = await deps.getBudgetState(ctx.familyId);
  const choice = selectModel(route, state, ctx);
  if (!choice.ok) throw new BudgetBlockedError(choice.reason, role);

  const attempt = async (model: ModelRef, fallbackUsed: boolean) => {
    if (!deps.providers[kind][model.provider]) {
      throw new AiNotConfiguredError(`provider "${model.provider}" is not supported for ${kind}`);
    }
    const started = deps.now();
    const base = {
      role,
      provider: model.provider,
      model: model.model,
      fallback_used: fallbackUsed,
      ...(ctx.ref ? { ref_table: ctx.ref.table, ref_id: ctx.ref.id } : {}),
      ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
    };
    try {
      const { value, usage } = await run(model, route.params);
      const costUsd = estimateCostUsd(await deps.loadPrice(model.provider, model.model), usage);
      await deps.recordCall(ctx.familyId, {
        ...base,
        status: "ok",
        input_tokens: usage.inputTokens + (usage.cacheWriteTokens ?? 0),
        output_tokens: usage.outputTokens,
        cached_input_tokens: usage.cachedInputTokens ?? 0,
        cost_usd: costUsd,
        latency_ms: deps.now() - started,
      });
      return { result: value, model, costUsd, fallbackUsed };
    } catch (e) {
      if (!(e instanceof AiNotConfiguredError)) {
        await deps.recordCall(ctx.familyId, {
          ...base,
          status: "error",
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          cost_usd: 0,
          latency_ms: deps.now() - started,
          error: (e as Error).message.slice(0, 300),
        });
      }
      throw e;
    }
  };

  try {
    return await attempt(choice.model, false);
  } catch (e) {
    const fb = fallbackOf(route, choice.model);
    const worthFallback = e instanceof ProviderError || e instanceof AiNotConfiguredError;
    if (!fb || !worthFallback) throw e;
    const result = await attempt(fb, true);
    await deps.notifyFallback(ctx.familyId, role, choice.model.model, fb.model);
    return result;
  }
}

/** Structured JSON answer validated by a Zod schema. */
export async function callStructured<S extends z.ZodType>(
  role: string,
  req: { system: string; prompt: string; schema: S },
  ctx: CallContext,
  deps: RouterDeps = defaultRouterDeps,
): Promise<RoutedResult<z.infer<S>>> {
  return routed(role, "structured", ctx, deps, async (model, params) => {
    const { data, usage } = await deps.providers.structured[model.provider]!({ model: model.model, ...req, params });
    return { value: data as z.infer<S>, usage };
  });
}

/** Embeddings for a batch of texts (role `embeddings`, docs/02 7.3). */
export async function embedTexts(
  texts: string[],
  ctx: CallContext,
  deps: RouterDeps = defaultRouterDeps,
): Promise<RoutedResult<number[][]>> {
  return routed("embeddings", "embed", ctx, deps, async (model, params) => {
    const { vectors, usage } = await deps.providers.embed[model.provider]!({
      model: model.model,
      texts,
      dimensions: params.dimensions,
      timeoutMs: params.timeout_ms,
    });
    return { value: vectors, usage };
  });
}
