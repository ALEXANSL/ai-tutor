import { NextResponse } from "next/server";
import { requireLessonAccess } from "@/server/auth/guards";
import { sameOrigin } from "@/server/voice/http";
import { ensureLessonVoiceConfig } from "@/server/voice/config";
import { transcribeAudio, defaultRouterDeps } from "@/server/ai/router";
import { loadRoute, loadPrice } from "@/server/ai/store";
import { unstable_rethrow } from "next/navigation";
export const maxDuration = 60;
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });
  const { familyId } = await requireLessonAccess();
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 180000) throw new Error("audio_size");
    const form = await request.formData(); const audio = form.get("audio");
    if (!(audio instanceof File) || !audio.size || audio.size > 150000 || !/^audio\/(webm|mp4|ogg|wav|mpeg)(;|$)/.test(audio.type)) throw new Error("audio_size");
    await ensureLessonVoiceConfig(familyId); const route = await loadRoute(familyId, "voice_transcription");
    if (!route || route.primary_provider !== "openai" || route.primary_model !== "whisper-1" || route.fallback_model || route.economy_model || route.escalation_model) throw new Error("audio_config");
    const price = await loadPrice("openai", "whisper-1"); if (!price || price.input_usd_per_mtok <= 0) throw new Error("audio_config");
    const result = await transcribeAudio(audio, { familyId }, { ...defaultRouterDeps, loadRoute: async () => ({ ...route, params: { ...route.params, timeout_ms: 30000 } }), loadPrice: async () => price });
    if (result.audioSeconds > 30) throw new Error("audio_size");
    return NextResponse.json({ text: result.result.trim().slice(0, 200) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { unstable_rethrow(error); return NextResponse.json({ message: "Не вдалося розчути запис. Спробуй коротку фразу або текстовий пошук." }, { status: 400 }); }
}
