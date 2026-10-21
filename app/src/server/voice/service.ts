import "server-only";
import { z } from "zod";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { getFriendChat, askFriendChat } from "@/server/lessons/friendChat";
import { askTopicChat } from "@/server/lessons/chat";
import { callAudio, transcribeAudio } from "@/server/ai/router";
import { getBudgetState } from "@/server/ai/store";
import { getServerSecret } from "@/server/env";
import { getTutorGender } from "@/server/persona/queries";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
import { lessonVoiceTargetSchema, resolveLessonVoiceTarget } from "./lessonContext";
import type { VoiceTurn } from "@/lib/voice";

const friendTarget = z.object({ kind: z.literal("friend"), chatId: z.string().uuid() });
export const voiceTargetSchema = z.union([friendTarget, lessonVoiceTargetSchema]);
export const voiceSessionCommand = z.union([
  z.object({ target: voiceTargetSchema }),
  z.object({ id: z.string().uuid(), action: z.enum(["renew", "stop"]) }),
]);
export type VoiceActor = { familyId: string; child: ChildProfileRow };
interface Lease { id: string; target: Record<string, unknown>; expires_at: string; ended_at: string | null; busy_until: string | null }

export async function voiceActor(familyId: string): Promise<VoiceActor> {
  const { data, error } = await forFamily(familyId).select("child_profile", "*").maybeSingle<ChildProfileRow>();
  if (error || !data) throw new Error("voice_unavailable");
  return { familyId, child: data };
}
async function budgetAllowed(familyId: string, kind: string, existing = false) {
  const state = await getBudgetState(familyId);
  if (state === "hard_stop" || (state === "budget" && (kind === "friend" || !existing))) throw new Error("voice_budget");
}
async function contextFor(actor: VoiceActor, raw: unknown) {
  // Stored voice metadata is server-owned and is not a client selector.
  const input = raw as Record<string, unknown>;
  const revision = input.revision;
  const selector = { ...input };
  delete selector.voiceId; delete selector.revision;
  const target = voiceTargetSchema.parse(selector);
  if (target.kind === "friend") {
    const chat = await getFriendChat(actor.familyId, actor.child.id, target.chatId);
    if (revision !== undefined && revision !== chat.revision) throw new Error("voice_expired");
    return { target, lesson: null };
  }
  const lesson = await resolveLessonVoiceTarget(actor.familyId, actor.child.id, target);
  return { target, lesson };
}
export async function manageVoice(actor: VoiceActor, raw: unknown) {
  const command = voiceSessionCommand.parse(raw);
  const scope = forFamily(actor.familyId);
  if ("target" in command) {
    if (!getServerSecret("OPENAI_API_KEY")) throw new Error("voice_unavailable");
    const { target } = await contextFor(actor, command.target);
    const revision = target.kind === "friend" ? (await getFriendChat(actor.familyId, actor.child.id, target.chatId)).revision : undefined;
    await budgetAllowed(actor.familyId, target.kind);
    const gender = await getTutorGender(actor.familyId, actor.child);
    let voiceId = gender === "m" ? "onyx" : "shimmer";
    if (actor.child.tutor_voice_id) {
      const { data } = await scope.select("tutor_voices", "provider, provider_voice_id").eq("id", actor.child.tutor_voice_id).maybeSingle<{ provider: string; provider_voice_id: string }>();
      if (data?.provider === "openai" && ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"].includes(data.provider_voice_id)) voiceId = data.provider_voice_id;
    }
    const { data, error } = await scope.client.rpc("manage_voice_session", { p_family_id: actor.familyId, p_child_id: actor.child.id, p_target: { ...target, voiceId, ...(revision !== undefined ? { revision } : {}) } }).single<Lease>();
    if (error || !data) throw new Error(error?.message.includes("voice_limit") ? "voice_limit" : "voice_unavailable");
    return { id: data.id, expiresAt: data.expires_at };
  }
  if (command.action === "renew") {
    const { data: current } = await scope.select("voice_sessions", "target").eq("id", command.id).eq("child_profile_id", actor.child.id).maybeSingle<Pick<Lease, "target">>();
    if (!current) throw new Error("voice_expired");
    await contextFor(actor, current.target);
    await budgetAllowed(actor.familyId, String(current.target.kind), true);
  }
  const { data, error } = await scope.client.rpc("manage_voice_session", { p_family_id: actor.familyId, p_child_id: actor.child.id, p_id: command.id, p_stop: command.action === "stop" }).single<Lease>();
  if (error || !data) throw new Error(error?.message.includes("voice_limit") ? "voice_limit" : "voice_expired");
  return { id: data.id, expiresAt: data.expires_at };
}

export async function voiceTurn(actor: VoiceActor, id: string, audio: File): Promise<VoiceTurn | { text: "" }> {
  z.string().uuid().parse(id);
  if (!getServerSecret("OPENAI_API_KEY")) throw new Error("voice_unavailable");
  if (!audio.size || audio.size > 1_000_000 || !/^audio\/(webm|mp4|ogg|wav|mpeg)(;|$)/.test(audio.type)) throw new Error("voice_audio");
  const scope = forFamily(actor.familyId);
  const { data: lease, error } = await scope.client.rpc("claim_voice_turn", { p_family_id: actor.familyId, p_child_id: actor.child.id, p_id: id }).single<Lease>();
  if (error || !lease) throw new Error("voice_expired");
  const busyUntil = lease.busy_until;
  try {
    let { target, lesson } = await contextFor(actor, lease.target);
    await budgetAllowed(actor.familyId, target.kind, true);
    const ctx = { familyId: actor.familyId, ...(lesson?.sessionId ? { sessionId: lesson.sessionId } : { ref: { table: "voice_sessions", id } }), sessionStartedBeforeBudget: target.kind !== "friend" };
    const transcript = await transcribeAudio(audio, ctx);
    if (transcript.audioSeconds > 30) {
      await manageVoice(actor, { id, action: "stop" });
      throw new Error("voice_audio");
    }
    const text = transcript.result.trim().slice(0, 800);
    if (!text) return { text: "" };
    // A stopped/expired session cannot continue creating replies after transcription.
    const { data: active } = await scope.select("voice_sessions", "id").eq("id", id).eq("child_profile_id", actor.child.id).is("ended_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (!active) throw new Error("voice_expired");
    ({ target, lesson } = await contextFor(actor, lease.target));
    const gender = await getTutorGender(actor.familyId, actor.child);
    let message;
    if (target.kind === "friend") {
      message = await askFriendChat(actor.familyId, actor.child.id, actor.child.nickname ?? "", actor.child.tutor_name ?? "", gender, text, target.chatId, true, Number(lease.target.revision));
    } else {
      if (!lesson) throw new Error("voice_expired");
      const [{ data: subject }, { data: topic }] = await Promise.all([
        scope.select("subjects", "name_uk").eq("id", lesson.subjectId).maybeSingle<{ name_uk: string }>(),
        scope.select("topics", "title").eq("id", lesson.topicId).maybeSingle<{ title: string }>(),
      ]);
      if (!subject || !topic) throw new Error("voice_expired");
      message = await askTopicChat(actor.familyId, actor.child.id, actor.child.nickname ?? "", actor.child.tutor_name ?? "", gender,
        lesson.subjectId, subject.name_uk, lesson.topicId, topic.title, text, lesson.sessionId, { voice: true, stepContext: lesson.context });
    }
    // A continuation may take time. Stop/clear/step changes while it runs
    // must not trigger another paid TTS call or speak into a different context.
    try {
      const { data: stillActive, error: activeError } = await scope.select("voice_sessions", "id")
        .eq("id", id).eq("child_profile_id", actor.child.id).eq("busy_until", busyUntil)
        .is("ended_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (activeError || !stillActive) throw new Error("voice_expired");
      await contextFor(actor, lease.target);
      await budgetAllowed(actor.familyId, target.kind, true);
    } catch {
      return { text, message, audio: null, endConversation: true };
    }
    let speech = null;
    try {
      // Only the final moderated text is spoken. No direct model-to-browser audio.
      speech = (await callAudio("voice_reply", { text: message.content, voiceId: String(lease.target.voiceId ?? "shimmer"), instructions: "Говори тепло й природно українською, як уважний репетитор. Чітко вимовляй математичні символи. Не додавай слів до наданого тексту." }, ctx)).result;
    } catch { /* The persisted text answer remains available if speech fails. */ }
    return { text, message, audio: speech, endConversation: message.content === URGENT_REPLY_UK };
  } finally {
    // Release only our own claim; an old request must not unlock a newer turn.
    if (busyUntil) await scope.update("voice_sessions", { busy_until: null }).eq("id", id).eq("child_profile_id", actor.child.id).eq("busy_until", busyUntil);
  }
}
