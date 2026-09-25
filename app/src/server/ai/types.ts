/**
 * Shared types of the AI access layer (ADR-004): the router picks a model for a
 * ROLE from the `model_routes` table, calls the provider, records the cost.
 */
export type BudgetState = "normal" | "warned" | "budget" | "hard_stop";

export interface ModelRef {
  provider: string;
  model: string;
}

export interface RouteParams {
  max_tokens?: number;
  timeout_ms?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  dimensions?: number;
  batch_size?: number;
  /** What to do in budget mode when no economy model is set (ADR-012). */
  budget_policy?: "defer" | "primary";
}

export interface ModelRoute {
  role: string;
  primary_provider: string;
  primary_model: string;
  fallback_provider: string | null;
  fallback_model: string | null;
  escalation_provider: string | null;
  escalation_model: string | null;
  economy_provider: string | null;
  economy_model: string | null;
  params: RouteParams;
}

/** A page image sent to a vision-capable model (D-54: OCR of scanned books). */
export interface VisionDocument {
  mediaType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  /** Base64, no data: prefix, no newlines. */
  data: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from the prompt cache (billed at the cache-read price). */
  cachedInputTokens?: number;
  /** Tokens written to the prompt cache. */
  cacheWriteTokens?: number;
}

export interface ModelPrice {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  cache_read_usd_per_mtok: number | null;
  cache_write_usd_per_mtok: number | null;
}

export interface CallContext {
  familyId: string;
  /** What the call is for (e.g. a material being indexed) — for per-item cost. */
  ref?: { table: string; id: string };
  sessionId?: string;
  /** Low confidence etc. → escalation model (US-13.3). */
  escalate?: boolean;
  /** A session started below 100 % finishes on normal models (US-11.5 KP-5). */
  sessionStartedBeforeBudget?: boolean;
}

export interface CallRecord {
  role: string;
  provider: string;
  model: string;
  status: "ok" | "error";
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  latency_ms: number;
  fallback_used: boolean;
  ref_table?: string;
  ref_id?: string;
  session_id?: string;
  error?: string;
}

/** Thrown when the budget forbids the call (hard stop, or "defer" in budget mode). */
export class BudgetBlockedError extends Error {
  constructor(
    readonly reason: "hard_stop" | "deferred",
    readonly role: string,
  ) {
    super(`AI call for role "${role}" blocked by budget (${reason})`);
    this.name = "BudgetBlockedError";
  }
}

/** Provider key missing, route missing, etc. — not retryable until someone configures it. */
export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

/** Provider call failed; `retryable` = worth trying again later / on the fallback. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
