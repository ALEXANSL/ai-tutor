import "server-only";
import { z } from "zod";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { askTopicChat, getOrCreateTopicChat } from "@/server/lessons/chat";
import { callAudio, transcribeAudio } from "@/server/ai/router";
import { getBudgetState } from "@/server/ai/store";
import { getServerSecret } from "@/server/env";
import { getTutorGender } from "@/server/persona/queries";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
import { lessonVoiceTargetSchema, resolveLessonVoiceTarget } from "./lessonContext";
import { createLease, readLease, renewLease, stopLease, claimLease, releaseLease } from "./leases";
import { ensureLessonVoiceConfig } from "./config";
import type { VoiceTurn } from "@/lib/voice";

export const voiceSessionCommand = z.union([
  z.object({ target: lessonVoiceTargetSchema }).strict(),
  z.object({ id: z.string().uuid(), action: z.enum(["renew", "stop"]) }).strict(),
]);
export type VoiceActor = { familyId: string; child: ChildProfileRow };
export async function voiceActor(familyId: string): Promise<VoiceActor> {
  const { data, error } = await forFamily(familyId).select("child_profile", "*").maybeSingle<ChildProfileRow>();
  if (error || !data) throw new Error("voice_unavailable");
  return { familyId, child: data };
}
async function budgetAllowed(familyId: string, existing = false) {
  const state = await getBudgetState(familyId);
  if (state === "hard_stop" || (state === "budget" && !existing)) throw new Error("voice_budget");
}
async function contextFor(actor: VoiceActor, raw: Record<string, unknown>) {
  const selector = { ...raw }; delete selector.voiceId;
  return resolveLessonVoiceTarget(actor.familyId, actor.child.id, lessonVoiceTargetSchema.parse(selector));
}
export async function manageVoice(actor: VoiceActor, raw: unknown) {
  const command = voiceSessionCommand.parse(raw);
  const scope = forFamily(actor.familyId);
  if ("target" in command) {
    if (!getServerSecret("OPENAI_API_KEY")) throw new Error("voice_unavailable");
    const lesson = await contextFor(actor, command.target);
    await budgetAllowed(actor.familyId);
    await ensureLessonVoiceConfig(actor.familyId);
    const gender = await getTutorGender(actor.familyId, actor.child);
    let voiceId = gender === "m" ? "onyx" : "shimmer";
    if (actor.child.tutor_voice_id) {
      const { data } = await scope.select("tutor_voices", "provider,provider_voice_id").eq("id", actor.child.tutor_voice_id).maybeSingle<{ provider: string; provider_voice_id: string }>();
      if (data?.provider === "openai" && ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"].includes(data.provider_voice_id)) voiceId = data.provider_voice_id;
    }
    const chatId = await getOrCreateTopicChat(actor.familyId, actor.child.id, lesson.subjectId, lesson.topicId);
    const lease = await createLease(scope, actor.child.id, chatId, { ...command.target, voiceId });
    return { id: lease.id, expiresAt: lease.expires_at };
  }
  if (command.action === "stop") {
    const lease = await stopLease(scope, actor.child.id, command.id);
    return { id: lease.id, expiresAt: lease.expires_at };
  }
  const current = await readLease(scope, actor.child.id, command.id);
  await contextFor(actor, current.target);
  await budgetAllowed(actor.familyId, true);
  const lease = await renewLease(scope, actor.child.id, command.id);
  return { id: lease.id, expiresAt: lease.expires_at };
}
export async function voiceTurn(actor: VoiceActor, id: string, audio: File): Promise<VoiceTurn | { text: "" }> {
  z.string().uuid().parse(id);
  if (!getServerSecret("OPENAI_API_KEY")) throw new Error("voice_unavailable");
  if (!audio.size || audio.size > 1_000_000 || !/^audio\/(webm|mp4|ogg|wav|mpeg)(;|$)/.test(audio.type)) throw new Error("voice_audio");
  const scope = forFamily(actor.familyId);
  const lease = await claimLease(scope, actor.child.id, id);
  const active = async () => {
    const current = await readLease(scope, actor.child.id, id);
    if (current.claim !== lease.claim) throw new Error("voice_expired");
    await budgetAllowed(actor.familyId, true);
    return contextFor(actor, current.target);
  };
  try {
    let lesson = await active();
    const ctx = { familyId: actor.familyId, ...(lesson.sessionId ? { sessionId: lesson.sessionId } : { ref: { table: "messages", id } }), sessionStartedBeforeBudget: true };
    const transcript = await transcribeAudio(audio, ctx);
    if (transcript.audioSeconds > 30) {
      await stopLease(scope, actor.child.id, id);
      throw new Error("voice_audio");
    }
    const text = transcript.result.trim().slice(0, 800);
    if (!text) return { text: "" };
    lesson = await active();
    const gender = await getTutorGender(actor.familyId, actor.child);
    const [{ data: subject }, { data: topic }] = await Promise.all([
      scope.select("subjects", "name_uk").eq("id", lesson.subjectId).maybeSingle<{ name_uk: string }>(),
      scope.select("topics", "title").eq("id", lesson.topicId).maybeSingle<{ title: string }>(),
    ]);
    if (!subject || !topic) throw new Error("voice_expired");
    const message = await askTopicChat(actor.familyId, actor.child.id, actor.child.nickname ?? "", actor.child.tutor_name ?? "", gender,
      lesson.subjectId, subject.name_uk, lesson.topicId, topic.title, text, lesson.sessionId, { voice: true, stepContext: lesson.context, ...(lesson.lessonRef ? { lessonRef: lesson.lessonRef } : {}) });
    try { await active(); }
    catch { return { text, message, audio: null, endConversation: true }; }
    let speech = null;
    try {
      speech = (await callAudio("voice_reply", { text: message.content, voiceId: String(lease.target.voiceId ?? "shimmer"), instructions: "Говори тепло й природно українською, як уважний репетитор. Не додавай слів до наданого тексту." }, ctx)).result;
    } catch { /* The moderated answer remains in the text transcript. */ }
    return { text, message, audio: speech, endConversation: message.content === URGENT_REPLY_UK };
  } finally {
    await releaseLease(scope, actor.child.id, id, lease.claim).catch(() => {});
  }
}
