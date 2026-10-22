import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { BudgetBlockedError, ProviderError } from "@/server/ai/types";

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}
export function voiceError(error: unknown) {
  const code = error instanceof BudgetBlockedError ? "voice_budget" : error instanceof Error && error.message === "voice_lesson_unavailable" ? "voice_expired" : error instanceof z.ZodError ? "voice_audio" : error instanceof Error && /^voice_(budget|expired|audio|unavailable)$/.test(error.message) ? error.message : "voice_unavailable";
  if (code === "voice_unavailable") console.error("lesson_voice_unavailable", {
    errorType: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof ProviderError ? { provider: error.provider, status: error.status } : {}),
  });
  const messages: Record<string, string> = {
    voice_budget: "Зараз продовжимо текстом. Голос можна буде ввімкнути пізніше.",
    voice_expired: "Голосова розмова завершилась. Натисни, щоб почати знову.",
    voice_audio: "Не вдалося розчути запис. Спробуй коротшу фразу.",
    voice_unavailable: "Зараз голос недоступний. Можемо продовжити текстом.",
  };
  return NextResponse.json({ error: code, message: messages[code] }, { status: code === "voice_audio" ? 400 : code === "voice_budget" ? 429 : 409 });
}
