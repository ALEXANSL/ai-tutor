import "server-only";
import { getServerSecret } from "@/server/env";
import { ProviderError } from "../types";
import { DEFAULT_ELEVENLABS_MODEL, elevenlabsTts } from "./elevenlabs";

/** Short phrase spoken by the check: about 17 characters, a fraction of a cent. */
const CHECK_TEXT = "Перевірка голосу.";

/**
 * Plain-Ukrainian explanation of why ElevenLabs refused, for the parent
 * (ADR-049). Built from the status code and ElevenLabs' short reason code
 * only; the reason never contains lesson text, the key or personal data.
 */
export function elevenLabsHint(status: number | null, reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("unusual_activity") || r.includes("free"))
    return "ElevenLabs заблокував виклик як підозрілий для безкоштовного тарифу. Потрібен платний тариф на тому акаунті, де створено ключ.";
  if (r.includes("missing_permissions") || r.includes("permission"))
    return "Ключу API бракує дозволу «Text to Speech». В ElevenLabs: Developers → API Keys → змініть ключ і увімкніть Text to Speech (або створіть ключ без обмежень), потім вставте його у Vercel як ELEVENLABS_API_KEY.";
  if (r.includes("voice_not_found") || (r.includes("voice") && status === 404))
    return "Голос із ELEVENLABS_VOICE_ID не знайдено у вашому акаунті. Відкрийте голос у Voice Library, натисніть «Add to my voices», скопіюйте його Voice ID з розділу My Voices і оновіть змінну у Vercel.";
  if (r.includes("quota") || r.includes("credits") || status === 402)
    return "Закінчився ліміт символів або тариф не дозволяє цей голос. Перевірте підписку в ElevenLabs (Subscription → Usage).";
  if (r.includes("invalid_api_key") || status === 401)
    return "ElevenLabs не приймає ключ. Скопіюйте ключ наново (Developers → API Keys) і вставте у Vercel як ELEVENLABS_API_KEY без пробілів.";
  if (status === 429) return "ElevenLabs тимчасово обмежив кількість запитів. Спробуйте за хвилину.";
  if (status !== null && status >= 500) return "У ElevenLabs зараз збій на їхньому боці. Спробуйте пізніше.";
  return "ElevenLabs відмовив з невідомої причини. Перешліть код помилки нижче Claude.";
}

export type ElevenLabsCheck =
  | { state: "ok" }
  | { state: "no_key" }
  | { state: "error"; status: number | null; reason: string; hint: string };

/** One tiny real synthesis call with the configured key, voice and model. */
export async function checkElevenLabs(): Promise<ElevenLabsCheck> {
  if (!getServerSecret("ELEVENLABS_API_KEY")) return { state: "no_key" };
  const model = getServerSecret("ELEVENLABS_MODEL_ID") || DEFAULT_ELEVENLABS_MODEL;
  try {
    await elevenlabsTts({ model, text: CHECK_TEXT, params: { timeout_ms: 20_000 } });
    return { state: "ok" };
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : null;
    const reason = (e as Error).message.replace(/^elevenlabs tts error \d+:?\s*/, "").slice(0, 200);
    return { state: "error", status, reason, hint: elevenLabsHint(status, reason) };
  }
}
