import "server-only";
import type { z } from "zod";
import { callStructured, callVisionStructured } from "@/server/ai/router";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError, type CallContext, type ModelRoute, type VisionDocument } from "@/server/ai/types";
import { forFamily } from "@/server/db/family-scope";
import { createServiceClient } from "@/server/supabase/clients";

export const LESSON_TUTOR_ROLE = "lesson_tutor";
export function tutorFailureMessage(error: unknown): string {
  if (error instanceof BudgetBlockedError) return "Запит призупинено через ліміт витрат на ШІ. Попроси тата перевірити «Бюджет і моделі».";
  if (error instanceof AiNotConfiguredError) return "Репетитору потрібні налаштування OpenAI. Попроси тата перевірити OPENAI_API_KEY та розділ «Бюджет і моделі».";
  if (error instanceof ProviderError) return `Не вдалося отримати відповідь OpenAI (${error.status ?? "з’єднання або час очікування"}). Запит залишився у полі — спробуй пізніше.`;
  return "Не вдалося отримати відповідь. Запит залишився у полі — спробуй ще раз.";
}
/** Explicit new route instead of silently overwriting an unknown legacy tutor_chat row. */
export async function ensureLessonTutorConfig(familyId: string): Promise<void> {
  const client = createServiceClient();
  // Official model page checked 2026-11-09: https://developers.openai.com/api/docs/models/gpt-5.4
  const { error: priceError } = await client.from("model_prices").upsert({ provider: "openai", model: "gpt-5.4", input_usd_per_mtok: 2.5, output_usd_per_mtok: 15, cache_read_usd_per_mtok: 0.25, notes: "GPT-5.4 list prices verified 2026-11-09, $/1M tokens for <=272K input. Tutor context is bounded well below that. Preserve existing price overrides." }, { onConflict: "provider,model", ignoreDuplicates: true });
  if (priceError) throw new AiNotConfiguredError("lesson_tutor_price_setup");
  const { error } = await client.from("model_routes").upsert({ family_id: familyId, role: LESSON_TUTOR_ROLE, primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: 6000, effort: "low", timeout_ms: 90_000, budget_policy: "primary" } }, { onConflict: "family_id,role", ignoreDuplicates: true });
  if (error) throw new AiNotConfiguredError("lesson_tutor_route_setup");
  const { data: route, error: routeError } = await forFamily(familyId).select("model_routes", "*").eq("role", LESSON_TUTOR_ROLE).maybeSingle<ModelRoute>();
  if (routeError || !route || route.primary_provider !== "openai" || [route.economy_provider, route.fallback_provider, route.escalation_provider].some(provider => provider && provider !== "openai")) throw new AiNotConfiguredError("lesson_tutor_requires_openai");
}

export async function callLessonTutor<S extends z.ZodType>(req: { system: string; prompt: string; schema: S; documents?: VisionDocument[] }, ctx: CallContext) {
  await ensureLessonTutorConfig(ctx.familyId);
  return req.documents?.length
    ? callVisionStructured(LESSON_TUTOR_ROLE, { ...req, documents: req.documents }, ctx)
    : callStructured(LESSON_TUTOR_ROLE, req, ctx);
}
