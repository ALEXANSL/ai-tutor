import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { callStructured } from "@/server/ai/router";
import { forFamily } from "@/server/db/family-scope";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { safetyPreambleUk } from "@/server/safety/preamble";
import type { TutorGender } from "@/i18n/uk";
import { moderateMessage } from "@/server/safety/moderate";
import { recordSafetyEvent } from "@/server/safety/events";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
import type { ChatMessageView } from "./chat";

/**
 * Material-scoped chat (US-23.1 КП-4, E-23, D-105): a sibling to
 * `askTopicChat` in `./chat.ts`, not a parameterization of it — a nonschool
 * material has no `subject_id`/`topic_id` (that's the whole point of "Інше",
 * ВП-54), and `askTopicChat` is deeply tied to `topic_id` throughout
 * (US-8.7's homework-problem cycle in particular, which is scoped to a
 * subject+topic and has no meaning for a standalone book). Grounds answers
 * ONLY in this material's own `chunks` — never mixed with another
 * book/textbook (КП-4) — and reuses the exact same safety primitives
 * (`moderateMessage`, `safetyPreambleUk`, `URGENT_REPLY_UK`,
 * `recordSafetyEvent`) as the topic chat, with NO relaxation (КП-5): the
 * material being outside the school programme changes nothing about safety.
 */
let promptCache: { system: string; user: string } | null = null;
function materialChatPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "material_chat.md"), "utf8"));
  return promptCache;
}

const answerSchema = z.object({ answerUk: z.string().min(1).max(1200) });

async function getOrCreateMaterialChat(familyId: string, childProfileId: string, materialId: string): Promise<string> {
  const scope = forFamily(familyId);
  const { data: existing } = await scope
    .select("chats", "id")
    .eq("child_profile_id", childProfileId)
    .eq("kind", "material")
    .eq("material_id", materialId)
    .maybeSingle<{ id: string }>();
  if (existing) return existing.id;
  const { data, error } = await scope.client
    .from("chats")
    .insert({ family_id: familyId, child_profile_id: childProfileId, kind: "material", material_id: materialId })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`creating the material chat failed: ${error?.message}`);
  return data.id;
}

/** КП-4: history between sessions is kept — one chat per "дитина + матеріал". */
export async function listMaterialChatMessages(familyId: string, childProfileId: string, materialId: string): Promise<{ chatId: string; messages: ChatMessageView[] }> {
  const chatId = await getOrCreateMaterialChat(familyId, childProfileId, materialId);
  const { data } = await forFamily(familyId)
    .select("messages", "id, author, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at")
    .returns<{ id: string; author: ChatMessageView["author"]; content: string; created_at: string }[]>();
  return { chatId, messages: (data ?? []).map((m) => ({ id: m.id, author: m.author, content: m.content, createdAt: m.created_at })) };
}

/** US-23.1 КП-4: answers from THIS material's own indexed fragments only, with a page citation. */
export async function askMaterialChat(
  familyId: string,
  childProfileId: string,
  nickname: string,
  tutorName: string,
  tutorGender: TutorGender,
  materialId: string,
  materialTitle: string,
  question: string,
  sessionId?: string,
): Promise<ChatMessageView> {
  const scope = forFamily(familyId);
  const chatId = await getOrCreateMaterialChat(familyId, childProfileId, materialId);
  const cleanQuestion = question.trim().slice(0, 800);

  // NFR-SAFE-4, US-12.1, КП-5: moderate BEFORE answering, in parallel with
  // generating the reply — no relaxation vs. `askTopicChat`.
  const moderation = moderateMessage({ familyId, sessionId, mode: "tutor_chat", message: cleanQuestion });

  await scope.client.from("messages").insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "child", type: "text", content: cleanQuestion });

  const { data: chunkRows } = await scope
    .select("chunks", "page, text")
    .eq("material_id", materialId)
    .order("ordinal")
    .limit(12)
    .returns<{ page: number | null; text: string }[]>();
  const { data: history } = await scope
    .select("messages", "author, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<{ author: string; content: string }[]>();

  const { system, user } = materialChatPrompt();
  const prompt = fillTemplate(user, {
    material_title: materialTitle,
    fragments: (chunkRows ?? []).map((c) => `[стор. ${c.page ?? "—"}]\n${c.text}`).join("\n\n") || "(немає проіндексованих фрагментів цієї книги)",
    history: (history ?? []).reverse().map((m) => `${m.author}: ${m.content}`).join("\n") || "(немає)",
    question: cleanQuestion,
  });
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName, material_title: materialTitle, nickname })}`;

  const [moderationResult, answerOutcome] = await Promise.all([
    moderation,
    callStructured("tutor_chat", { system: system2, prompt, schema: answerSchema }, { familyId, sessionId })
      .then((res) => res.result.answerUk)
      .catch(() => null),
  ]);
  await recordSafetyEvent(familyId, childProfileId, "tutor_chat", cleanQuestion, moderationResult, { sessionId, chatId }).catch(
    (e: Error) => console.error(`recordSafetyEvent (material_chat) failed: ${e.message}`),
  );
  // NFR-SAFE-4, US-12.1 КП-2 / КП-5: "urgent" always gets the deterministic
  // "go to dad now" reply — no exception for "it's just a nonschool book".
  const answerText =
    moderationResult.severity === "urgent"
      ? URGENT_REPLY_UK
      : (answerOutcome ?? "Зараз не вдалося відповісти — спробуй, будь ласка, ще раз за хвилинку.");

  const { data: saved, error } = await scope.client
    .from("messages")
    .insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "ai", type: "text", content: answerText })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (error || !saved) throw new Error(`saving the material-chat answer failed: ${error?.message}`);
  return { id: saved.id, author: "ai", content: answerText, createdAt: saved.created_at };
}
