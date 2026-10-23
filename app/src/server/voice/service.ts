import "server-only";
import { z } from "zod";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { askTopicChat, getOrCreateTopicChat } from "@/server/lessons/chat";
import { askFriendChat } from "@/server/lessons/friendChat";
import { callAudio, transcribeAudio } from "@/server/ai/router";
import { getBudgetState } from "@/server/ai/store";
import { getServerSecret } from "@/server/env";
import { getTutorGender } from "@/server/persona/queries";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
import { lessonVoiceTargetSchema, resolveLessonVoiceTarget } from "./lessonContext";
import { assertLessonVoiceAccess, type LessonVoiceAccess } from "./lessonAccess";
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
function targetFor(raw: Record<string, unknown>) {
  const selector = { ...raw }; delete selector.voiceId;
  return lessonVoiceTargetSchema.parse(selector);
}
async function contextFor(actor: VoiceActor, raw: Record<string, unknown>) {
  return resolveLessonVoiceTarget(actor.familyId, actor.child.id, targetFor(raw));
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
    // S46: a friend-chat target already names the (ownership-checked by
    // `contextFor` above) chat it belongs to — several now exist per child,
    // so there is no longer a single one to get-or-create.
    const chatId = command.target.kind === "friend"
      ? command.target.chatId
      : await getOrCreateTopicChat(actor.familyId, actor.child.id, lesson.subjectId!, lesson.topicId!);
    const lease = await createLease(scope, actor.child.id, chatId, { ...command.target, voiceId });
    return { id: lease.id, expiresAt: lease.expires_at };
  }
  if (command.action === "stop") {
    const lease = await stopLease(scope, actor.child.id, command.id);
    return { id: lease.id, expiresAt: lease.expires_at };
  }
  const current = await readLease(scope, actor.child.id, command.id);
  await Promise.all([assertLessonVoiceAccess(actor.familyId, actor.child.id, targetFor(current.target)), budgetAllowed(actor.familyId, true)]);
  const lease = await renewLease(scope, actor.child.id, command.id);
  return { id: lease.id, expiresAt: lease.expires_at };
}
export async function voiceTurn(actor: VoiceActor, id: string, audio: File): Promise<VoiceTurn | { text: "" }> {
  z.string().uuid().parse(id);
  if (!getServerSecret("OPENAI_API_KEY")) throw new Error("voice_unavailable");
  if (!audio.size || audio.size > 1_000_000 || !/^audio\/(webm|mp4|ogg|wav|mpeg)(;|$)/.test(audio.type)) throw new Error("voice_audio");
  const scope = forFamily(actor.familyId);
  const lease = await claimLease(scope, actor.child.id, id);
  let expectedAccess: LessonVoiceAccess | undefined;
  const active = async () => {
    const current = await readLease(scope, actor.child.id, id);
    if (current.claim !== lease.claim) throw new Error("voice_expired");
    const [access] = await Promise.all([
      assertLessonVoiceAccess(actor.familyId, actor.child.id, targetFor(current.target)),
      budgetAllowed(actor.familyId, true),
    ]);
    if (expectedAccess && (access.subjectId !== expectedAccess.subjectId || access.topicId !== expectedAccess.topicId || access.sessionId !== expectedAccess.sessionId)) throw new Error("voice_expired");
    expectedAccess ??= access;
    return access;
  };
  try {
    const access = await active();
    const ctx = { familyId: actor.familyId, ...(access.sessionId ? { sessionId: access.sessionId } : { ref: { table: "messages", id } }), sessionStartedBeforeBudget: true };
    const transcript = await transcribeAudio(audio, ctx);
    if (transcript.audioSeconds > 30) {
      await stopLease(scope, actor.child.id, id);
      throw new Error("voice_audio");
    }
    const text = transcript.result.trim().slice(0, 800);
    if (!text) return { text: "" };
    const currentAccess = await active();
    const lesson = await contextFor(actor, lease.target);
    if (lesson.subjectId !== currentAccess.subjectId || lesson.topicId !== currentAccess.topicId || lesson.sessionId !== currentAccess.sessionId
      || lesson.subjectId !== access.subjectId || lesson.topicId !== access.topicId || lesson.sessionId !== access.sessionId) throw new Error("voice_expired");
    const parsedTarget = targetFor(lease.target);
    let message;
    if (parsedTarget.kind === "friend") {
      // US-8.5/S46 "ШІ-друг": no subject/topic to re-hydrate or re-check —
      // the same free-topic path the text chat already uses, in the same
      // named chat the target selected (already ownership-checked above).
      await active();
      message = await askFriendChat(actor.familyId, actor.child.id, parsedTarget.chatId, actor.child.nickname ?? "", actor.child.tutor_name ?? "", actor.child.tutor_name_gender, text);
    } else {
      const [gender, { data: subject }, { data: topic }] = await Promise.all([
        getTutorGender(actor.familyId, actor.child),
        scope.select("subjects", "name_uk").eq("id", lesson.subjectId!).maybeSingle<{ name_uk: string }>(),
        scope.select("topics", "title").eq("id", lesson.topicId!).maybeSingle<{ title: string }>(),
      ]);
      if (!subject || !topic) throw new Error("voice_expired");
      // Hydration and metadata reads can outlast a stop/navigation. Recheck
      // immediately before starting the paid tutor response.
      await active();
      message = await askTopicChat(actor.familyId, actor.child.id, actor.child.nickname ?? "", actor.child.tutor_name ?? "", gender,
        lesson.subjectId!, subject.name_uk, lesson.topicId!, topic.title, text, lesson.sessionId, { voice: true, stepContext: lesson.context, ...(lesson.lessonRef ? { lessonRef: lesson.lessonRef } : {}) });
    }
    const safetyEnd = message.content === URGENT_REPLY_UK;
    try { await active(); }
    catch { return { text, message, audio: null, endConversation: true, endReason: safetyEnd ? "safety" : "inactive" }; }
    let speech = null;
    try {
      speech = (await callAudio("voice_reply", { text: message.content, voiceId: String(lease.target.voiceId ?? "shimmer"), instructions: "Говори тепло й природно українською, як уважний репетитор. Не додавай слів до наданого тексту." }, ctx)).result;
    } catch { /* The moderated answer remains in the text transcript. */ }
    // TTS may finish after a stop, navigation, archival or budget change.
    // Never return audio from a turn that no longer has authorization.
    try { await active(); }
    catch { return { text, message, audio: null, endConversation: true, endReason: safetyEnd ? "safety" : "inactive" }; }
    return { text, message, audio: speech, endConversation: safetyEnd, ...(safetyEnd ? { endReason: "safety" as const } : {}) };
  } finally {
    await releaseLease(scope, actor.child.id, id, lease.claim).catch(() => {});
  }
}
