import "server-only";
import { createHash } from "node:crypto";
import { callAudio } from "@/server/ai/router";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError } from "@/server/ai/types";

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
 * Synthesizes narration for a step's readable text. Never throws: a budget
 * refusal, a missing provider key, or a provider failure all resolve to
 * `null` — the child silently keeps the text-only step (docs/04 §5: "при
 * недоступності голосу... стан замінюється на нейтральний... без згадки
 * причини"), matching how live-voice unavailability already behaves.
 */
export async function synthesizeStepNarration(
  familyId: string,
  sessionId: string,
  text: string,
): Promise<NarrationAudio | null> {
  const trimmed = text.trim().slice(0, MAX_NARRATION_CHARS);
  if (!trimmed) return null;
  try {
    const res = await callAudio("passive_narration", { text: trimmed }, { familyId, sessionId });
    return res.result;
  } catch (e) {
    if (e instanceof BudgetBlockedError || e instanceof AiNotConfiguredError || e instanceof ProviderError) return null;
    console.error(`synthesizeStepNarration failed: ${(e as Error).message}`);
    return null;
  }
}
