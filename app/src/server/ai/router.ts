import "server-only";
import type { z } from "zod";
import { estimateCostUsd, fallbackOf, selectModel } from "./policy";
import { anthropicStructured, anthropicVisionStructured } from "./providers/anthropic";
import { openaiEmbed, openaiStructured, openaiTts } from "./providers/openai";
import * as store from "./store";
import {
  AiNotConfiguredError,
  BudgetBlockedError,
  ProviderError,
  type AudioResult,
  type BudgetState,
  type CallContext,
  type CallRecord,
  type ModelPrice,
  type ModelRef,
  type ModelRoute,
  type PromptContent,
  type RouteParams,
  type Usage,
  type VisionDocument,
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
    (req: { model: string; system: string; prompt: PromptContent; schema: z.ZodType; params: RouteParams }) => Promise<{
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
  /** Structured output with page images/PDF attached (D-54: `ocr_page` role). */
  vision: Record<
    string,
    (req: {
      model: string;
      system: string;
      prompt: string;
      schema: z.ZodType;
      params: RouteParams;
      documents: VisionDocument[];
    }) => Promise<{ data: unknown; usage: Usage }>
  >;
  /** Text-to-speech (role `passive_narration`, ADR-025) — not the tutor's live voice (ADR-006). */
  audio: Record<
    string,
    (req: { model: string; text: string; voiceId?: string; params: RouteParams }) => Promise<{ data: AudioResult; usage: Usage }>
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
    structured: { anthropic: (req) => anthropicStructured(req), openai: (req) => openaiStructured(req) },
    embed: { openai: (req) => openaiEmbed(req) },
    vision: { anthropic: (req) => anthropicVisionStructured(req) },
    // No `gemini` adapter yet (ADR-025's alternative/fallback provider) — the
    // `passive_narration` route's fallback stays inert until one is added
    // (documented in the seed migration), same caveat pattern already used
    // elsewhere for an unconfirmed reserve provider.
    audio: { openai: (req) => openaiTts(req) },
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
      // ADR-023 §Частина 1.5: tags this call as belonging to a
      // `library.warm_topic` background job, for the daily warm-up budget.
      ...(ctx.jobId ? { job_id: ctx.jobId } : {}),
    };
    try {
      const { value, usage } = await run(model, route.params);
      const costUsd = estimateCostUsd(await deps.loadPrice(model.provider, model.model), usage);
      await deps.recordCall(ctx.familyId, {
        ...base,
        status: "ok",
        // ADR-033 (tracking gap fix): cache-write tokens are billed at their
        // own (higher) rate and now stored in their own column — no longer
        // folded into `input_tokens` before the write, so a later per-role
        // token-usage read can tell a cache write apart from ordinary input.
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cached_input_tokens: usage.cachedInputTokens ?? 0,
        cache_write_tokens: usage.cacheWriteTokens ?? 0,
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
          cache_write_tokens: 0,
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
  req: { system: string; prompt: PromptContent; schema: S },
  ctx: CallContext,
  deps: RouterDeps = defaultRouterDeps,
): Promise<RoutedResult<z.infer<S>>> {
  return routed(role, "structured", ctx, deps, async (model, params) => {
    const { data, usage } = await deps.providers.structured[model.provider]!({ model: model.model, ...req, params });
    return { value: data as z.infer<S>, usage };
  });
}

/** Structured JSON answer from a vision-capable model given page images/PDF (role `ocr_page`, D-54). */
export async function callVisionStructured<S extends z.ZodType>(
  role: string,
  req: { system: string; prompt: string; schema: S; documents: VisionDocument[] },
  ctx: CallContext,
  deps: RouterDeps = defaultRouterDeps,
): Promise<RoutedResult<z.infer<S>>> {
  return routed(role, "vision", ctx, deps, async (model, params) => {
    const { data, usage } = await deps.providers.vision[model.provider]!({ model: model.model, ...req, params });
    return { value: data as z.infer<S>, usage };
  });
}

/**
 * Passive narration audio for already-generated text (role `passive_narration`,
 * ADR-025 — reads a step's own text aloud, not the tutor's live voice). The
 * `/v1/audio/speech` endpoint has no token usage in its response, so the cost
 * estimate treats `text.length` (characters) as `inputTokens` against a price
 * row priced per-million-characters (see the S5 seed migration comment).
 */
export async function callAudio(
  role: string,
  req: { text: string; voiceId?: string },
  ctx: CallContext,
  deps: RouterDeps = defaultRouterDeps,
): Promise<RoutedResult<AudioResult>> {
  return routed(role, "audio", ctx, deps, async (model, params) => {
    const { data } = await deps.providers.audio[model.provider]!({ model: model.model, ...req, params });
    // The TTS endpoint reports no per-call usage (see providers/openai.ts's
    // `openaiTts`) — character count stands in for `inputTokens` against the
    // per-million-character price row seeded for this role (S5 migration).
    return { value: data, usage: { inputTokens: req.text.length, outputTokens: 0 } };
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
