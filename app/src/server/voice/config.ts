import "server-only";
import { createServiceClient } from "@/server/supabase/clients";

/** Add routes as ordinary configuration rows, preserving parent overrides.
 * Existing tables already support arbitrary roles; no DDL or new credentials. */
export async function ensureLessonVoiceConfig(familyId: string) {
  const client = createServiceClient();
  const { error: priceError } = await client.from("model_prices").upsert({ provider: "openai", model: "whisper-1", input_usd_per_mtok: 100, output_usd_per_mtok: 0, notes: "$0.006/min. input_tokens = rounded audio seconds; $100/1M seconds." }, { onConflict: "provider,model", ignoreDuplicates: true });
  if (priceError) { console.error("lesson_voice_setup: model price row unavailable"); throw new Error("voice_unavailable"); }
  const { error } = await client.from("model_routes").upsert([
    { family_id: familyId, role: "voice_transcription", primary_provider: "openai", primary_model: "whisper-1", params: { timeout_ms: 30_000, budget_policy: "defer" } },
    { family_id: familyId, role: "voice_reply", primary_provider: "openai", primary_model: "gpt-4o-mini-tts", params: { timeout_ms: 30_000, budget_policy: "defer" } },
  ], { onConflict: "family_id,role", ignoreDuplicates: true });
  if (error) { console.error("lesson_voice_setup: model route rows unavailable"); throw new Error("voice_unavailable"); }
}
