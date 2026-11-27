import "server-only";
import { createHash } from "node:crypto";
import { callAudio, defaultRouterDeps, type RouterDeps } from "@/server/ai/router";
import { DEFAULT_ELEVENLABS_MODEL } from "@/server/ai/providers/elevenlabs";
import { getServerSecret } from "@/server/env";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError, type ModelPrice, type ModelRoute } from "@/server/ai/types";

/**
 * Passive narration (US-6.16 КП-5, ADR-025): reads a lesson step's OWN,
 * already-generated text aloud — an extension of the existing step
 * renderer, not a new `library_steps.type` and not the heavy
 * planning/generation/review pipeline (US-6.9…6.14). No karaoke-style
 * word timing (PO/D-89: MVP is fine without it).
 */

const MAX_NARRATION_CHARS = 4000;

/**
 * The visible text a step's renderer already shows the child, for every step
 * type the lesson screen supports (docs/04 §11.4's "слайд/контрольна
 * точка/…"). Pure and unit-tested — no I/O, no model call.
 */
export function readableTextForStep(step: { type: string; content: Record<string, unknown> }): string {
  const parts: string[] = [];
  if (typeof step.content.textUk === "string") parts.push(step.content.textUk);
  if (typeof step.content.exampleUk === "string") parts.push(step.content.exampleUk);
  if (typeof step.content.questionUk === "string") parts.push(step.content.questionUk);
  if (step.type === "choice" && Array.isArray(step.content.options)) {
    for (const o of step.content.options as { textUk?: unknown }[]) {
      if (typeof o?.textUk === "string") parts.push(o.textUk);
    }
  }
  return parts.join(". ").trim();
}

export interface NarrationAudio {
  audioBase64: string;
  mimeType: string;
}

/**
 * Cache key for a step's narration audio (PO complaint 2026-10-02: no
 * caching at all meant every view/replay/revisit re-synthesized from
 * scratch). Hashes the EXACT text that would be sent to TTS (post-trim, same
 * `MAX_NARRATION_CHARS` cutoff as `synthesizeStepNarration`) so a later edit
 * to the step's content correctly invalidates the cached audio — see
 * `library_steps.narration_text_hash` (migration
 * `20261015100000_tts_narration_cache.sql`).
 */
export function narrationTextHash(text: string): string {
  return createHash("sha256").update(text.trim().slice(0, MAX_NARRATION_CHARS)).digest("hex");
}

/**
 * Synthesizes narration for an arbitrary piece of already-written text.
 * Never throws: a budget refusal, a missing provider key, or a provider
 * failure all resolve to `null` — the caller falls back to text-only
 * (docs/04 §5: "при недоступності голосу... стан замінюється на
 * нейтральний... без згадки причини"), matching how live-voice
 * unavailability already behaves.
 *
 * 2026-10-07 (S35): generalized from `synthesizeStepNarration` (sessionId
 * was mandatory, tying every narration to a `lesson_sessions` row) to take
 * a `ref` instead — the S33/S34/S35 content screens (`literature_lessons`/
 * `course_lessons`/`course_v2_*`) are stateless content views with no
 * session row at all. `CallContext` (`server/ai/types.ts`) already
 * supports `ref` as an independent, optional field alongside `sessionId`
 * (per-item cost attribution), so no router change was needed — only this
 * function's own signature. `synthesizeStepNarration` below is now a thin
 * wrapper kept for the existing `LessonRunner`/`NarrationPlayer` call site.
 */
export async function synthesizeNarration(familyId: string, ref: { table: string; id: string } | { sessionId: string }, text: string, language?: string): Promise<NarrationAudio | null> {
  const trimmed = text.trim().slice(0, MAX_NARRATION_CHARS);
  if (!trimmed) return null;
  try {
    return await requestNarration(familyId, ref, trimmed, language);
  } catch (e) {
    if (e instanceof BudgetBlockedError || e instanceof AiNotConfiguredError || e instanceof ProviderError) return null;
    console.error(`synthesizeNarration failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * ADR-049: ElevenLabs list price for Multilingual v2/v3 ($0.08 per 1K
 * characters, elevenlabs.io/pricing/api, checked 2026-11-27). Kept in code so
 * no migration is needed; the subscription is prepaid, so this is the
 * family's effective per-character cost on the Creator plan (≈$22 / 275K).
 */
export const ELEVENLABS_PRICE: ModelPrice = { input_usd_per_mtok: 80, output_usd_per_mtok: 0, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null };

/**
 * ElevenLabs becomes the primary narration voice while the family's own
 * route (OpenAI) stays as the fallback, so an exhausted quota, a wrong key or
 * an outage silently falls back to the voice that worked before.
 */
export function withElevenLabsPrimary(route: ModelRoute, model: string): ModelRoute {
  return { ...route, primary_provider: "elevenlabs", primary_model: model, fallback_provider: route.primary_provider, fallback_model: route.primary_model, economy_provider: null, economy_model: null, escalation_provider: null, escalation_model: null };
}

/**
 * Router deps for passive narration: ElevenLabs first when ELEVENLABS_API_KEY
 * is set; `undefined` (the router's own defaults) otherwise.
 */
export function narrationDeps(secret: typeof getServerSecret = getServerSecret, baseDeps?: RouterDeps): RouterDeps | undefined {
  if (!secret("ELEVENLABS_API_KEY")) return baseDeps;
  const base = baseDeps ?? defaultRouterDeps;
  const model = secret("ELEVENLABS_MODEL_ID") ?? DEFAULT_ELEVENLABS_MODEL;
  return {
    ...base,
    loadRoute: async (familyId, role) => {
      const route = await base.loadRoute(familyId, role);
      return route ? withElevenLabsPrimary(route, model) : null;
    },
    loadPrice: async (provider, name) => (provider === "elevenlabs" ? ELEVENLABS_PRICE : base.loadPrice(provider, name)),
  };
}

/** Background jobs need typed provider and budget errors for scheduling. */
export async function requestNarration(familyId: string, ref: { table: string; id: string } | { sessionId: string }, text: string, language?: string): Promise<NarrationAudio> {
  const trimmed = text.trim().slice(0, MAX_NARRATION_CHARS);
  const ctx = "sessionId" in ref ? { familyId, sessionId: ref.sessionId } : { familyId, ref };
  const instructions = language?.startsWith("en") ? "Read verbatim in natural English. Do not translate. Speak clearly for a school learner." : language?.startsWith("de") ? "Lies den Text auf natürlichem Deutsch wortgetreu vor. Nicht übersetzen. Sprich deutlich für ein Schulkind." : "Читай дослівно, тепло й спокійно. Пояснення українською; англійські й німецькі слова та фрази вимовляй природно мовою оригіналу. Не перекладай і не транслітеруй.";
  const res = await callAudio("passive_narration", { text: trimmed, instructions }, ctx, narrationDeps());
  return res.result;
}

/** @deprecated kept for the existing `LessonRunner` call site — new code should call `synthesizeNarration` with a `ref` instead of a `sessionId`. */
export async function synthesizeStepNarration(familyId: string, sessionId: string, text: string): Promise<NarrationAudio | null> {
  return synthesizeNarration(familyId, { sessionId }, text);
}
