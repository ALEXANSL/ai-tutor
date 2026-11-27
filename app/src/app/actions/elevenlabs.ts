"use server";

import { requireParentAccess } from "@/server/auth/guards";
import { checkElevenLabs } from "@/server/ai/providers/elevenlabs-check";
import type { FormState } from "./state";

/** Parent-only: says in plain words whether the ElevenLabs narration voice works (ADR-049). */
export async function checkElevenLabsAction(): Promise<FormState> {
  await requireParentAccess();
  const result = await checkElevenLabs();
  if (result.state === "ok") return { status: "ok", message: "Голос ElevenLabs працює: ключ, голос і модель прийняті." };
  if (result.state === "no_key") return { status: "error", message: "Ключ ELEVENLABS_API_KEY не задано у Vercel, тому озвучує OpenAI." };
  return { status: "error", message: `${result.hint} Код: ${result.status ?? "мережа"}${result.reason ? ` (${result.reason})` : ""}.` };
}
