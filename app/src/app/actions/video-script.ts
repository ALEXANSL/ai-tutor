"use server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError } from "@/server/ai/types";
import { loadVideoLessonSource, VideoSourceError } from "@/server/video-script/source";
import { generateVideoScript, saveVideoDraft, videoOptionsSchema } from "@/server/video-script/service";
import type { VideoDraft } from "@/lib/video-script";

const inputSchema = videoOptionsSchema.extend({ subjectId: z.string().uuid(), topicId: z.string().uuid() });
export type VideoScriptResult = { status: "ok"; draft: VideoDraft; saved: boolean } | { status: "error"; message: string };
export async function generateVideoScriptAction(input: z.infer<typeof inputSchema>): Promise<VideoScriptResult> {
  const { familyId } = await requireParentAccess();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", message: "Перевірте урок, тривалість і побажання (до 1200 символів)." };
  try {
    const { subjectId, topicId, minutes, notes } = parsed.data;
    const source = await loadVideoLessonSource(familyId, subjectId, topicId);
    const draft = await generateVideoScript(familyId, source, { minutes, notes });
    let saved = false;
    try { saved = await saveVideoDraft(familyId, subjectId, topicId, draft); } catch { /* Return the paid result even when storage is temporarily unavailable. */ }
    return { status: "ok", draft, saved };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof VideoSourceError) return { status: "error", message: error.message };
    if (error instanceof BudgetBlockedError) return { status: "error", message: "Генерація призупинена через ліміт витрат на ШІ. Перевірте «Бюджет і моделі»." };
    if (error instanceof AiNotConfiguredError) return { status: "error", message: "Перевірте OPENAI_API_KEY і налаштування OpenAI для сценаріїв. Ця функція використовує тільки OpenAI." };
    if (error instanceof ProviderError) return { status: "error", message: `OpenAI не підготував сценарій (${error.status ?? "з’єднання або час очікування"}). Спробуйте пізніше; попередній сценарій збережено.` };
    return { status: "error", message: "Не вдалося підготувати перевірений сценарій. Попередній результат залишився доступним. Спробуйте ще раз." };
  }
}
