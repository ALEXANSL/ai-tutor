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

/** Each friend conversation has its own context. Clearing only resets the
 * child-facing history: the parent's verbatim journal and safety events remain. */
export interface FriendChatRow {
  id: string;
  title: string;
  revision: number;
  cleared_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface FriendChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
const CHAT_COLUMNS = "id, title, revision, cleared_at, archived_at, created_at, updated_at";
const titleSchema = z.string().trim().min(1).max(60);
const messageSchema = z.string().trim().min(1).max(800);
const answerSchema = z.object({ answerUk: z.string().min(1).max(800) });

export class FriendChatChangedError extends Error {
  constructor() { super("friend chat unavailable or changed; reload the conversation"); }
}
function summary(row: FriendChatRow): FriendChatSummary {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}
function activeChats(familyId: string, childProfileId: string) {
  return forFamily(familyId).select("chats", CHAT_COLUMNS)
    .eq("child_profile_id", childProfileId).eq("kind", "friend").is("archived_at", null);
}
async function insertFriendChat(familyId: string, childProfileId: string, title: string): Promise<FriendChatRow> {
  // The child and family columns each have an FK, but their pairing must also
  // be checked before using a service-role insertion.
  const scope = forFamily(familyId);
  const { data: child, error: childError } = await scope.select("child_profile", "id")
    .eq("id", childProfileId).maybeSingle<{ id: string }>();
  if (childError) throw new Error("checking friend-chat owner failed");
  if (!child) throw new FriendChatChangedError();
  const { data, error } = await scope.insert("chats", {
    child_profile_id: childProfileId, kind: "friend", title: titleSchema.parse(title),
  }).select(CHAT_COLUMNS).single<FriendChatRow>();
  if (error || !data) throw new Error("creating the friend chat failed");
  return data;
}
export async function createFriendChat(familyId: string, childProfileId: string, title = "Нова розмова"): Promise<FriendChatSummary> {
  return summary(await insertFriendChat(familyId, childProfileId, title));
}
export async function listFriendChats(familyId: string, childProfileId: string): Promise<FriendChatSummary[]> {
  const { data, error } = await activeChats(familyId, childProfileId)
    .order("updated_at", { ascending: false }).order("id", { ascending: false }).returns<FriendChatRow[]>();
  if (error) throw new Error("listing friend chats failed");
  return (data ?? []).map(summary);
}
export async function getFriendChat(familyId: string, childProfileId: string, chatId?: string): Promise<FriendChatRow> {
  const query = activeChats(familyId, childProfileId);
  const { data, error } = await (chatId !== undefined ? query.eq("id", chatId) : query.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(1))
    .maybeSingle<FriendChatRow>();
  if (error) throw new Error("loading the friend chat failed");
  if (data) return data;
  // An explicit missing, archived or foreign conversation must never silently
  // fall back to another conversation or create one under a supplied id.
  if (chatId !== undefined) throw new FriendChatChangedError();
  return insertFriendChat(familyId, childProfileId, "Нова розмова");
}
async function editFriendChat(familyId: string, childProfileId: string, chatId: string, action: "rename" | "clear" | "archive", title?: string): Promise<void> {
  const chat = await getFriendChat(familyId, childProfileId, chatId);
  const { error } = await forFamily(familyId).client.rpc("edit_friend_chat", {
    p_family_id: familyId, p_child_id: childProfileId, p_chat_id: chat.id,
    p_revision: chat.revision, p_action: action, p_title: title ?? null,
  });
  if (error) throw new FriendChatChangedError();
}
export async function renameFriendChat(familyId: string, childProfileId: string, chatId: string, title: string): Promise<void> {
  await editFriendChat(familyId, childProfileId, chatId, "rename", titleSchema.parse(title));
}
export async function clearFriendChat(familyId: string, childProfileId: string, chatId: string): Promise<void> {
  await editFriendChat(familyId, childProfileId, chatId, "clear");
}
export async function archiveFriendChat(familyId: string, childProfileId: string, chatId: string): Promise<void> {
  await editFriendChat(familyId, childProfileId, chatId, "archive");
}
function visibleMessages(familyId: string, chat: FriendChatRow, columns: string) {
  const query = forFamily(familyId).select("messages", columns).eq("chat_id", chat.id);
  return chat.cleared_at ? query.gt("created_at", chat.cleared_at) : query;
}
export async function listFriendChatMessages(familyId: string, childProfileId: string, chatId?: string): Promise<{ chatId: string; messages: ChatMessageView[] }> {
  const chat = await getFriendChat(familyId, childProfileId, chatId);
  const { data, error } = await visibleMessages(familyId, chat, "id, author, content, created_at")
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .returns<{ id: string; author: ChatMessageView["author"]; content: string; created_at: string }[]>();
  if (error) throw new Error("listing friend-chat messages failed");
  return { chatId: chat.id, messages: (data ?? []).reverse().map((m) => ({ id: m.id, author: m.author, content: m.content, createdAt: m.created_at })) };
}
async function appendMessage(familyId: string, childProfileId: string, chat: FriendChatRow, author: "child" | "ai", content: string, voice: boolean): Promise<ChatMessageView> {
  // The RPC locks the chat and checks the revision, so an AI reply completing
  // after clear/archive in another tab cannot resurrect the old context.
  const { data, error } = await forFamily(familyId).client.rpc("append_friend_message", {
    p_family_id: familyId, p_child_id: childProfileId, p_chat_id: chat.id,
    p_revision: chat.revision, p_author: author, p_content: content, p_voice: voice,
  }).single<{ id: string; created_at: string }>();
  if (error || !data) throw new FriendChatChangedError();
  return { id: data.id, author, content, createdAt: data.created_at };
}

let promptCache: { system: string; user: string } | null = null;
function friendChatPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "friend_chat.md"), "utf8"));
  return promptCache;
}
export async function askFriendChat(
  familyId: string, childProfileId: string, nickname: string, tutorName: string,
  tutorGender: TutorGender, message: string, chatId?: string, voice = false, expectedRevision?: number,
): Promise<ChatMessageView> {
  const chat = await getFriendChat(familyId, childProfileId, chatId);
  if (expectedRevision !== undefined && chat.revision !== expectedRevision) throw new FriendChatChangedError();
  const cleanMessage = messageSchema.parse(message);
  const { data: history, error } = await visibleMessages(familyId, chat, "author, content")
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(20)
    .returns<{ author: string; content: string }[]>();
  if (error) throw new Error("loading friend-chat context failed");
  await appendMessage(familyId, childProfileId, chat, "child", cleanMessage, voice);
  const moderation = moderateMessage({
    familyId, mode: "friend_chat", message: cleanMessage,
    context: (history ?? []).slice(0, 3).reverse().map((m) => m.content),
  });
  const { system, user } = friendChatPrompt();
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName, nickname })}`;
  const prompt = fillTemplate(user, {
    history: [...(history ?? [])].reverse().map((m) => `${m.author}: ${m.content}`).join("\n") || "(немає)",
    message: cleanMessage,
  });
  const [moderationResult, answerOutcome] = await Promise.all([
    moderation,
    callStructured("friend_chat", { system: system2, prompt, schema: answerSchema }, { familyId })
      .then((res) => res.result.answerUk).catch(() => null),
  ]);
  await recordSafetyEvent(familyId, childProfileId, "friend_chat", cleanMessage, moderationResult, { chatId: chat.id }).catch((e: Error) =>
    console.error(`recordSafetyEvent (friend_chat) failed: ${e.message}`),
  );
  const answer = moderationResult.severity === "urgent" ? URGENT_REPLY_UK
    : (answerOutcome ?? "Зараз не вдалося відповісти — спробуй, будь ласка, ще раз за хвилинку.");
  return appendMessage(familyId, childProfileId, chat, "ai", answer, voice);
}
