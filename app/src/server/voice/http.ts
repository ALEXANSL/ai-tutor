import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { BudgetBlockedError } from "@/server/ai/types";
import { FriendChatChangedError } from "@/server/lessons/friendChat";

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === new URL(request.url).origin;
}
export function voiceError(error: unknown) {
  const code = error instanceof BudgetBlockedError ? "voice_budget" : error instanceof FriendChatChangedError || (error instanceof Error && error.message === "voice_lesson_unavailable") ? "voice_expired" : error instanceof z.ZodError ? "voice_audio" : error instanceof Error && /^voice_(limit|budget|expired|audio|unavailable)$/.test(error.message) ? error.message : "voice_unavailable";
  const messages: Record<string, string> = {
    voice_limit: "На сьогодні голосова розмова з другом завершилася. Можемо продовжити текстом 🙂",
    voice_budget: "Зараз продовжимо текстом. Голос можна буде ввімкнути пізніше.",
    voice_expired: "Голосова розмова завершилась. Натисни, щоб почати знову.",
    voice_audio: "Не вдалося розчути запис. Спробуй коротшу фразу.",
    voice_unavailable: "Зараз голос недоступний. Можемо продовжити текстом.",
  };
  return NextResponse.json({ error: code, message: messages[code] }, { status: code === "voice_audio" ? 400 : code === "voice_limit" || code === "voice_budget" ? 429 : 409 });
}
