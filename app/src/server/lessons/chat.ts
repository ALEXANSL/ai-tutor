import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { callStructured } from "@/server/ai/router";
import { forFamily } from "@/server/db/family-scope";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";

/**
 * Topic chat (US-8.1, 8.2): one chat per subject+topic per child; answers
 * are grounded in the topic's indexed textbook fragments with page
 * citations. Nickname and tutor name ARE part of this role's context
 * (docs/02 5.4) — real name/e-mail never are (NFR-SAFE-8).
 */
let promptCache: { system: string; user: string } | null = null;
function tutorChatPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "tutor_chat.md"), "utf8"));
  return promptCache;
}

const answerSchema = z.object({ answerUk: z.string().min(1).max(1200) });

export interface ChatMessageView {
  id: string;
  author: "child" | "ai" | "system" | "parent";
  content: string;
  createdAt: string;
}

async function getOrCreateChat(familyId: string, childProfileId: string, subjectId: string, topicId: string): Promise<string> {
  const scope = forFamily(familyId);
  const { data: existing } = await scope
    .select("chats", "id")
    .eq("child_profile_id", childProfileId)
    .eq("topic_id", topicId)
    .maybeSingle<{ id: string }>();
  if (existing) return existing.id;
  const { data, error } = await scope.client
    .from("chats")
    .insert({ family_id: familyId, child_profile_id: childProfileId, kind: "subject_topic", subject_id: subjectId, topic_id: topicId })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`creating the topic chat failed: ${error?.message}`);
  return data.id;
}

export async function listChatMessages(familyId: string, childProfileId: string, subjectId: string, topicId: string): Promise<{ chatId: string; messages: ChatMessageView[] }> {
  const chatId = await getOrCreateChat(familyId, childProfileId, subjectId, topicId);
  const { data } = await forFamily(familyId)
    .select("messages", "id, author, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at")
    .returns<{ id: string; author: ChatMessageView["author"]; content: string; created_at: string }[]>();
  return { chatId, messages: (data ?? []).map((m) => ({ id: m.id, author: m.author, content: m.content, createdAt: m.created_at })) };
}

/** US-8.1 КП-1: answers from the topic's textbook, with a page citation when relevant. */
export async function askTopicChat(
  familyId: string,
  childProfileId: string,
  nickname: string,
  tutorName: string,
  subjectId: string,
  subjectName: string,
  topicId: string,
  topicTitle: string,
  question: string,
  sessionId?: string,
): Promise<ChatMessageView> {
  const scope = forFamily(familyId);
  const chatId = await getOrCreateChat(familyId, childProfileId, subjectId, topicId);

  const { data: chunkRows } = await scope.client
    .from("chunks")
    .select("page, text, materials(title, name)")
    .eq("owner_family_id", familyId)
    .eq("topic_id", topicId)
    .order("ordinal")
    .limit(12)
    .returns<{ page: number | null; text: string; materials: { title: string | null; name: string } | { title: string | null; name: string }[] | null }[]>();
  const { data: history } = await scope
    .select("messages", "author, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<{ author: string; content: string }[]>();

  const cleanQuestion = question.trim().slice(0, 800);
  await scope.client.from("messages").insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "child", type: "text", content: cleanQuestion });

  const { system, user } = tutorChatPrompt();
  const prompt = fillTemplate(user, {
    fragments: (chunkRows ?? []).map((c) => `[стор. ${c.page ?? "—"}]\n${c.text}`).join("\n\n") || "(немає проіндексованих фрагментів цієї теми)",
    history: (history ?? []).reverse().map((m) => `${m.author}: ${m.content}`).join("\n") || "(немає)",
    question: cleanQuestion,
  });
  const system2 = fillTemplate(system, { tutor_name: tutorName, subject_name: subjectName, topic_title: topicTitle, nickname });

  let answerText: string;
  try {
    const res = await callStructured("tutor_chat", { system: system2, prompt, schema: answerSchema }, { familyId, sessionId });
    answerText = res.result.answerUk;
  } catch {
    answerText = "Зараз не вдалося відповісти — спробуй, будь ласка, ще раз за хвилинку.";
  }

  const { data: saved, error } = await scope.client
    .from("messages")
    .insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "ai", type: "text", content: answerText })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (error || !saved) throw new Error(`saving the chat answer failed: ${error?.message}`);
  return { id: saved.id, author: "ai", content: answerText, createdAt: saved.created_at };
}
