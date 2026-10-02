import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { narrationTextHash, readableTextForStep, synthesizeStepNarration, type NarrationAudio } from "@/server/lessons/narration";

/**
 * PO complaint 2026-10-02: switching a step to voice mode could take up to
 * ~30s before narration started — confirmed by reading `narration.ts`/
 * `lesson.ts`/`openai.ts`'s `openaiTts`: EVERY view of a step called the
 * OpenAI TTS endpoint synchronously, with no caching at all, so even
 * replaying the exact same step (or revisiting it in a later session, or
 * reusing the same library item for a repeat lesson — US-6's whole point)
 * paid the full round trip again every time.
 *
 * This persists synthesized audio on the step's own `library_steps` row
 * (migration `20261015100000_tts_narration_cache.sql`) keyed by a hash of
 * the exact narrated text, so a cache hit is a single already-scoped SELECT
 * (no AI call, $0, instant) and only a genuine first-time/edited-text miss
 * pays for synthesis.
 */
type NarrationCacheRow = {
  id: string;
  type: string;
  content: Record<string, unknown>;
  narration_text_hash: string | null;
  narration_audio_base64: string | null;
  narration_audio_mime: string | null;
};

/**
 * Looks up (or synthesizes + caches) narration audio for one already-loaded
 * step row. Never throws — same "silently fall back to text" contract as
 * `synthesizeStepNarration` (a cache WRITE failure after a successful
 * synthesis still returns the audio to the caller; only the caching is
 * best-effort).
 */
export async function getOrSynthesizeStepNarration(
  familyId: string,
  sessionId: string,
  stepRow: NarrationCacheRow,
): Promise<NarrationAudio | null> {
  const text = readableTextForStep(stepRow);
  if (!text) return null;
  const hash = narrationTextHash(text);

  if (stepRow.narration_text_hash === hash && stepRow.narration_audio_base64 && stepRow.narration_audio_mime) {
    return { audioBase64: stepRow.narration_audio_base64, mimeType: stepRow.narration_audio_mime };
  }

  const audio = await synthesizeStepNarration(familyId, sessionId, text);
  if (!audio) return null;

  try {
    await forFamily(familyId)
      .update("library_steps", {
        narration_text_hash: hash,
        narration_audio_base64: audio.audioBase64,
        narration_audio_mime: audio.mimeType,
        narration_cached_at: new Date().toISOString(),
      })
      .eq("id", stepRow.id);
  } catch (e) {
    // Caching is a pure optimization — a write failure must never turn a
    // successful synthesis into a lost narration for the child.
    console.error(`getOrSynthesizeStepNarration: cache write failed: ${(e as Error).message}`);
  }

  return audio;
}
