import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { callStructured } from "@/server/ai/router";
import { forFamily } from "@/server/db/family-scope";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { moderateMessage } from "@/server/safety/moderate";
import { recordSafetyEvent } from "@/server/safety/events";
import { safetyPreambleUk } from "@/server/safety/preamble";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
import type { TutorGender } from "@/i18n/uk";
import type { ChatMessageView } from "./chat";

/**
 * "ШІ-друг" (US-8.5): a free-topic chat, one per child, separate from every
 * subject/topic chat. **The parent sees it verbatim** (КП-3) — same
 * `messages` table, `parent_visibility = 'full'` default, no separate code
 * path needed for that part. Every child message is moderated exactly like
 * a topic-chat question or a lesson answer (NFR-SAFE-4, US-12.1 КП-3: "works
 * the same in text, voice and ШІ-друг").
 */
let promptCache: { system: string; user: string } | null = null;
function friendChatPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "friend_chat.md"), "utf8"));
  return promptCache;
}

const answerSchema = z.object({ answerUk: z.string().min(1).max(800) });

async function getOrCreateFriendChat(familyId: string, childProfileId: string): Promise<string> {
  const scope = forFamily(familyId);
  const { data: existing } = await scope.select("chats", "id").eq("child_profile_id", childProfileId).eq("kind", "friend").maybeSingle<{ id: string }>();
  if (existing) return existing.id;
  const { data, error } = await scope.client
    .from("chats")
    .insert({ family_id: familyId, child_profile_id: childProfileId, kind: "friend" })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`creating the friend chat failed: ${error?.message}`);
  return data.id;
}

export async function listFriendChatMessages(familyId: string, childProfileId: string): Promise<{ chatId: string; messages: ChatMessageView[] }> {
  const chatId = await getOrCreateFriendChat(familyId, childProfileId);
  const { data } = await forFamily(familyId)
    .select("messages", "id, author, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at")
    .returns<{ id: string; author: ChatMessageView["author"]; content: string; created_at: string }[]>();
  return { chatId, messages: (data ?? []).map((m) => ({ id: m.id, author: m.author, content: m.content, createdAt: m.created_at })) };
}

export async function askFriendChat(
  familyId: string,
  childProfileId: string,
  nickname: string,
  tutorName: string,
  tutorGender: TutorGender,
  message: string,
): Promise<ChatMessageView> {
  const scope = forFamily(familyId);
  const chatId = await getOrCreateFriendChat(familyId, childProfileId);
  const cleanMessage = message.trim().slice(0, 800);

  const { data: history } = await scope
    .select("messages", "author, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<{ author: string; content: string }[]>();

  const moderation = moderateMessage({
    familyId,
    mode: "friend_chat",
    message: cleanMessage,
    context: (history ?? []).slice(0, 3).reverse().map((m) => m.content),
  });

  await scope.client.from("messages").insert({ family_id: familyId, chat_id: chatId, author: "child", type: "text", content: cleanMessage });

  const { system, user } = friendChatPrompt();
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName, nickname })}`;
  const prompt = fillTemplate(user, {
    history: (history ?? []).reverse().map((m) => `${m.author}: ${m.content}`).join("\n") || "(немає)",
    message: cleanMessage,
  });

  const [moderationResult, answerOutcome] = await Promise.all([
    moderation,
    callStructured("friend_chat", { system: system2, prompt, schema: answerSchema }, { familyId })
      .then((res) => res.result.answerUk)
      .catch(() => null),
  ]);
  await recordSafetyEvent(familyId, childProfileId, "friend_chat", cleanMessage, moderationResult, { chatId }).catch((e: Error) =>
    console.error(`recordSafetyEvent (friend_chat) failed: ${e.message}`),
  );
  const answerText =
    moderationResult.severity === "urgent"
      ? URGENT_REPLY_UK
      : (answerOutcome ?? "Зараз не вдалося відповісти — спробуй, будь ласка, ще раз за хвилинку.");

  const { data: saved, error } = await scope.client
    .from("messages")
    .insert({ family_id: familyId, chat_id: chatId, author: "ai", type: "text", content: answerText })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (error || !saved) throw new Error(`saving the friend-chat answer failed: ${error?.message}`);
  return { id: saved.id, author: "ai", content: answerText, createdAt: saved.created_at };
}
