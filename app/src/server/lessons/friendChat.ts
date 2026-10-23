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
 * "ШІ-друг" (US-8.5, S46 2026-10-23 "окремі іменовані чати"): several
 * free-topic chats per child, each its own `chats` row (`kind = 'friend'`),
 * separate from every subject/topic chat. **The parent always sees every
 * chat verbatim** (КП-3) — same `messages` table, `parent_visibility =
 * 'full'` default, no separate code path, and NO row is ever deleted here:
 * "deleting" a chat (Алекс 2026-10-23) only sets `hidden_from_child_at`,
 * removing it from the child's own list while `/parent/conversations`
 * (which selects every `chats` row with no filter) keeps showing it
 * unchanged. Every child message is moderated exactly like a topic-chat
 * question or a lesson answer (NFR-SAFE-4, US-12.1 КП-3: "works the same in
 * text, voice and ШІ-друг").
 */
let promptCache: { system: string; user: string } | null = null;
function friendChatPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "friend_chat.md"), "utf8"));
  return promptCache;
}

const answerSchema = z.object({ answerUk: z.string().min(1).max(800) });

export interface FriendChatSummary {
  id: string;
  title: string;
  createdAt: string;
}

function fallbackTitle(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "Розмова" : `Розмова від ${date.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" })}`;
}

/** Visible to the child — hidden chats (soft-"deleted") are excluded. The
 * parent's own reader (`/parent/conversations`) queries `chats` directly
 * with no such filter, by design (КП-3). */
export async function listFriendChats(familyId: string, childProfileId: string): Promise<FriendChatSummary[]> {
  const { data } = await forFamily(familyId)
    .select("chats", "id, title, created_at")
    .eq("child_profile_id", childProfileId)
    .eq("kind", "friend")
    .is("hidden_from_child_at", null)
    .order("created_at", { ascending: false })
    .returns<{ id: string; title: string | null; created_at: string }[]>();
  return (data ?? []).map((c) => ({ id: c.id, title: c.title ?? fallbackTitle(c.created_at), createdAt: c.created_at }));
}

/** A new, separately named chat ("окремі іменовані чати") — never reuses or
 * clears an existing one, unlike the old single-chat `getOrCreateFriendChat`. */
export async function createFriendChat(familyId: string, childProfileId: string): Promise<FriendChatSummary> {
  const scope = forFamily(familyId);
  const { count } = await scope.count("chats").eq("child_profile_id", childProfileId).eq("kind", "friend");
  const title = `Розмова ${(count ?? 0) + 1}`;
  const { data, error } = await scope.client
    .from("chats")
    .insert({ family_id: familyId, child_profile_id: childProfileId, kind: "friend", title })
    .select("id, title, created_at")
    .single<{ id: string; title: string; created_at: string }>();
  if (error || !data) throw new Error(`creating the friend chat failed: ${error?.message}`);
  return { id: data.id, title: data.title, createdAt: data.created_at };
}

/** Child-facing "delete": hides the chat from the child's own list only —
 * never deletes it, so the parent keeps seeing it (КП-3). Throws if `chatId`
 * is not this child's own friend chat (never trust a client-supplied id). */
export async function hideFriendChat(familyId: string, childProfileId: string, chatId: string): Promise<void> {
  const scope = forFamily(familyId);
  const { data: owned } = await scope.select("chats", "id").eq("id", chatId).eq("child_profile_id", childProfileId).eq("kind", "friend").maybeSingle<{ id: string }>();
  if (!owned) throw new Error("friend chat not found");
  const { error } = await scope.client.from("chats").update({ hidden_from_child_at: new Date().toISOString() }).eq("id", chatId);
  if (error) throw new Error(`hiding the friend chat failed: ${error.message}`);
}

/** A hidden chat ("deleted" by the child, S46) is off-limits to further
 * child-initiated reads/writes too, not just absent from their list — it
 * still exists for the parent, just never through child-facing actions. */
async function requireOwnFriendChat(familyId: string, childProfileId: string, chatId: string): Promise<void> {
  const { data } = await forFamily(familyId).select("chats", "id").eq("id", chatId).eq("child_profile_id", childProfileId).eq("kind", "friend").is("hidden_from_child_at", null).maybeSingle<{ id: string }>();
  if (!data) throw new Error("friend chat not found");
}

export async function listFriendChatMessages(familyId: string, childProfileId: string, chatId: string): Promise<ChatMessageView[]> {
  await requireOwnFriendChat(familyId, childProfileId, chatId);
  const { data } = await forFamily(familyId)
    .select("messages", "id, author, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at")
    .returns<{ id: string; author: ChatMessageView["author"]; content: string; created_at: string }[]>();
  return (data ?? []).map((m) => ({ id: m.id, author: m.author, content: m.content, createdAt: m.created_at }));
}

export async function askFriendChat(
  familyId: string,
  childProfileId: string,
  chatId: string,
  nickname: string,
  tutorName: string,
  tutorGender: TutorGender,
  message: string,
): Promise<ChatMessageView> {
  const scope = forFamily(familyId);
  await requireOwnFriendChat(familyId, childProfileId, chatId);
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
