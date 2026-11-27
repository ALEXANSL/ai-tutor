import "server-only";
import { getServerSecret } from "@/server/env";
import { AiNotConfiguredError, ProviderError, type AudioResult, type RouteParams, type Usage } from "../types";

/**
 * ElevenLabs text-to-speech (ADR-049): the narration voice for narrated
 * presentations and every other passive narration once
 * `ELEVENLABS_API_KEY` is set. Only already-written lesson text is sent —
 * never the child's name or any personal data (CLAUDE.md, NFR-PRIV).
 */
const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech/";

/** Premade multilingual voice used until the parent picks a Ukrainian one (ELEVENLABS_VOICE_ID). */
export const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";

/** ElevenLabs voice ids are 20 alphanumeric characters; OpenAI voice names ("alloy") are not. */
export function isElevenLabsVoiceId(value: string | undefined | null): value is string {
  return !!value && /^[A-Za-z0-9]{20}$/.test(value);
}

export function elevenLabsVoiceId(requested?: string): string {
  if (isElevenLabsVoiceId(requested)) return requested;
  const configured = getServerSecret("ELEVENLABS_VOICE_ID");
  return isElevenLabsVoiceId(configured) ? configured : DEFAULT_ELEVENLABS_VOICE_ID;
}

export interface ElevenLabsTtsRequest {
  model: string;
  text: string;
  voiceId?: string;
  params: RouteParams;
}

export async function elevenlabsTts(req: ElevenLabsTtsRequest, fetchImpl: typeof fetch = fetch): Promise<{ data: AudioResult; usage: Usage }> {
  const key = getServerSecret("ELEVENLABS_API_KEY");
  if (!key) throw new AiNotConfiguredError("ELEVENLABS_API_KEY is not set");
  if (!req.text.trim()) throw new ProviderError("elevenlabs tts: empty text", "elevenlabs", null, false);
  const voice = elevenLabsVoiceId(req.voiceId);
  let res: Response;
  try {
    res = await fetchImpl(`${ENDPOINT}${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/mpeg", "xi-api-key": key },
      body: JSON.stringify({
        text: req.text,
        model_id: req.model,
        // Calm, steady teacher voice; speed matches the OpenAI baseline (D-111 п.5).
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.05 },
      }),
      signal: AbortSignal.timeout(req.params.timeout_ms ?? 60_000),
    });
  } catch (e) {
    throw new ProviderError(`elevenlabs network error: ${(e as Error).name}`, "elevenlabs", null, true);
  }
  if (!res.ok) {
    // 401 = wrong key, 402/quota = subscription used up: both are worth falling back to OpenAI.
    const retryable = res.status === 429 || res.status >= 500;
    const reason = await errorReason(res);
    throw new ProviderError(`elevenlabs tts error ${res.status}${reason ? `: ${reason}` : ""}`, "elevenlabs", res.status, retryable);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new ProviderError("elevenlabs tts: empty audio", "elevenlabs", res.status, true);
  return { data: { audioBase64: bytes.toString("base64"), mimeType: "audio/mpeg" }, usage: { inputTokens: 0, outputTokens: 0 } };
}

/**
 * ElevenLabs explains a refusal in `detail` ({status, message} or a validation list):
 * e.g. "missing_permissions", "voice_not_found", "quota_exceeded". Kept short for the AI log;
 * the response never echoes the key.
 */
async function errorReason(res: Response): Promise<string> {
  try {
    const text = await res.text();
    let detail: unknown = text;
    try { detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text; } catch { /* plain text */ }
    const reason = typeof detail === "string" ? detail
      : detail && typeof detail === "object" && "status" in detail
        ? [(detail as { status?: unknown }).status, (detail as { message?: unknown }).message].filter(Boolean).join(" — ")
        : JSON.stringify(detail);
    return reason.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}
