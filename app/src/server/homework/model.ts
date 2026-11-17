import "server-only";
import type { z } from "zod";
import { createServiceClient } from "@/server/supabase/clients";
import { forFamily } from "@/server/db/family-scope";
import { callStructured, callVisionStructured } from "@/server/ai/router";
import { AiNotConfiguredError, type CallContext, type ModelRoute, type VisionDocument } from "@/server/ai/types";
/** File authoring has its own output budget; increasing it never changes the live tutor/chat route. */
export async function callHomeworkModel<S extends z.ZodType>(request: { system: string; prompt: string; schema: S; documents?: VisionDocument[] }, context: CallContext) {
  const db = createServiceClient(); const role = "homework_author";
  const price = await db.from("model_prices").upsert({ provider: "openai", model: "gpt-5.4", input_usd_per_mtok: 2.5, output_usd_per_mtok: 15, cache_read_usd_per_mtok: 0.25, notes: "Existing verified GPT-5.4 price; preserve owner overrides." }, { onConflict: "provider,model", ignoreDuplicates: true });
  if (price.error) throw new AiNotConfiguredError("homework_author_price");
  const saved = await db.from("model_routes").upsert({ family_id: context.familyId, role, primary_provider: "openai", primary_model: "gpt-5.4", params: { max_tokens: 16000, effort: "medium", timeout_ms: 120000, budget_policy: "primary" } }, { onConflict: "family_id,role", ignoreDuplicates: true });
  if (saved.error) throw new AiNotConfiguredError("homework_author");
  const route = await forFamily(context.familyId).select("model_routes", "*").eq("role", role).maybeSingle<ModelRoute>();
  if (route.error || !route.data || route.data.primary_provider !== "openai" || [route.data.fallback_provider, route.data.economy_provider, route.data.escalation_provider].some(provider => provider && provider !== "openai")) throw new AiNotConfiguredError("homework_author_openai");
  return request.documents?.length ? callVisionStructured(role, { ...request, documents: request.documents }, context) : callStructured(role, request, context);
}
