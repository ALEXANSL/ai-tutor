import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { callStructured } from "@/server/ai/router";
import { forFamily } from "@/server/db/family-scope";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { safetyPreambleUk } from "@/server/safety/preamble";
import { moderateMessage } from "@/server/safety/moderate";
import { recordSafetyEvent } from "@/server/safety/events";
import type { TutorGender } from "@/i18n/uk";

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

interface ChatChunkRow {
  page: number | null;
  text: string;
  materials: { title: string | null; name: string; kind: string } | { title: string | null; name: string; kind: string }[] | null;
}

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
  tutorGender: TutorGender,
  subjectId: string,
  subjectName: string,
  topicId: string,
  topicTitle: string,
  question: string,
  sessionId?: string,
): Promise<ChatMessageView> {
  const scope = forFamily(familyId);
  const chatId = await getOrCreateChat(familyId, childProfileId, subjectId, topicId);
  const cleanQuestion = question.trim().slice(0, 800);

  // NFR-SAFE-4, US-12.1: moderate the child's own message before answering it
  // (in parallel with generating the reply — ADR-009 §4 — so this never adds
  // latency the child notices).
  const moderation = moderateMessage({ familyId, sessionId, mode: "tutor_chat", message: cleanQuestion });

  const { data: chunkRows } = await scope.client
    .from("chunks")
    .select("page, text, materials(title, name, kind)")
    .eq("owner_family_id", familyId)
    .eq("topic_id", topicId)
    .order("ordinal")
    .limit(12)
    .returns<ChatChunkRow[]>();
  const { data: history } = await scope
    .select("messages", "author, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<{ author: string; content: string }[]>();

  await scope.client.from("messages").insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "child", type: "text", content: cleanQuestion });

  const { system, user } = tutorChatPrompt();
  const kindOf = (row: ChatChunkRow) => (Array.isArray(row.materials) ? row.materials[0]?.kind : row.materials?.kind);
  const sorted = [...(chunkRows ?? [])].sort((a, b) => (kindOf(a) === "textbook" ? -1 : 0) - (kindOf(b) === "textbook" ? -1 : 0));
  const prompt = fillTemplate(user, {
    // BUG-010: the textbook is labeled and listed first — the prompt below tells the model it outranks a book.
    fragments:
      sorted
        .map((c) => {
          const m = Array.isArray(c.materials) ? c.materials[0] : c.materials;
          const label = m?.kind === "textbook" ? `ПІДРУЧНИК, стор. ${c.page ?? "—"}` : `КНИГА «${m?.title ?? m?.name ?? "?"}», стор. ${c.page ?? "—"}`;
          return `[${label}]\n${c.text}`;
        })
        .join("\n\n") || "(немає проіндексованих фрагментів цієї теми)",
    history: (history ?? []).reverse().map((m) => `${m.author}: ${m.content}`).join("\n") || "(немає)",
    question: cleanQuestion,
  });
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName, subject_name: subjectName, topic_title: topicTitle, nickname })}`;

  const [moderationResult, answerOutcome] = await Promise.all([
    moderation,
    callStructured("tutor_chat", { system: system2, prompt, schema: answerSchema }, { familyId, sessionId })
      .then((res) => res.result.answerUk)
      .catch(() => null),
  ]);
  await recordSafetyEvent(familyId, childProfileId, "tutor_chat", cleanQuestion, moderationResult, { sessionId, chatId }).catch(
    (e: Error) => console.error(`recordSafetyEvent (tutor_chat) failed: ${e.message}`),
  );
  // NFR-SAFE-4, US-12.1 КП-2: "urgent" always gets the deterministic "go to
  // dad now" reply — never the tutor_chat model's own answer, whatever it
  // said, so this rule cannot be missed or phrased away by the model.
  const answerText =
    moderationResult.severity === "urgent"
      ? "Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе."
      : (answerOutcome ?? "Зараз не вдалося відповісти — спробуй, будь ласка, ще раз за хвилинку.");

  const { data: saved, error } = await scope.client
    .from("messages")
    .insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "ai", type: "text", content: answerText })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (error || !saved) throw new Error(`saving the chat answer failed: ${error?.message}`);
  return { id: saved.id, author: "ai", content: answerText, createdAt: saved.created_at };
}
