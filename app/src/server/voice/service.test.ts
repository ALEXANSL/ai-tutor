import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProfileRow } from "@/server/db/types";

const CHILD = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const STEP = "55555555-5555-4555-8555-555555555555";
const FAM = "66666666-6666-4666-8666-666666666666";
const BUSY = "2030-10-21T12:01:30.000Z";
const actor = { familyId: FAM, child: { id: CHILD, family_id: FAM, nickname: "Зірочка", tutor_name: "Ліра", tutor_name_gender: "f", tutor_voice_id: null } as ChildProfileRow };
const message = { id: "reply", author: "ai", content: "Перевірена відповідь", createdAt: "2026-10-21T12:00:00Z" };
let active = true;
let selectedVoice: { provider: string; provider_voice_id: string } | null = null;
let lease: { id: string; target: Record<string, unknown>; expires_at: string; ended_at: string | null; busy_until: string | null };
const queryLog: { family: string; table: string; filters: [string, unknown][] }[] = [];
const updateLog: { family: string; table: string; values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
const rpc = vi.fn();
function scope(family: string) {
  return {
    select: (table: string) => {
      const log = { family, table, filters: [] as [string, unknown][] }; queryLog.push(log);
      const self = {
        eq: (k: string, v: unknown) => { log.filters.push([k, v]); return self; },
        is: (k: string, v: unknown) => { log.filters.push([k, v]); return self; },
        gt: (k: string, v: unknown) => { log.filters.push([k, v]); return self; },
        maybeSingle: () => Promise.resolve({ data: table === "voice_sessions" ? (active ? lease : null) : table === "child_profile" ? actor.child : table === "tutor_voices" ? selectedVoice : table === "subjects" ? { name_uk: "Математика" } : table === "topics" ? { title: "Дроби" } : null, error: null }),
      };
      return self;
    },
    update: (table: string, values: Record<string, unknown>) => {
      const log = { family, table, values, filters: [] as [string, unknown][] }; updateLog.push(log);
      const promise = Promise.resolve({ error: null });
      const self = { eq: (k: string, v: unknown) => { log.filters.push([k, v]); return self; }, then: promise.then.bind(promise) };
      return self;
    },
    client: { rpc: (...args: unknown[]) => rpc(...args) },
  };
}
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => scope(family) }));
const getFriendChat = vi.fn(); const askFriendChat = vi.fn(); const askTopicChat = vi.fn();
vi.mock("@/server/lessons/friendChat", () => ({ getFriendChat: (...a: unknown[]) => getFriendChat(...a), askFriendChat: (...a: unknown[]) => askFriendChat(...a) }));
vi.mock("@/server/lessons/chat", () => ({ askTopicChat: (...a: unknown[]) => askTopicChat(...a) }));
const transcribeAudio = vi.fn(); const callAudio = vi.fn();
vi.mock("@/server/ai/router", () => ({ transcribeAudio: (...a: unknown[]) => transcribeAudio(...a), callAudio: (...a: unknown[]) => callAudio(...a) }));
const getBudgetState = vi.fn();
vi.mock("@/server/ai/store", () => ({ getBudgetState: (...a: unknown[]) => getBudgetState(...a) }));
const getServerSecret = vi.fn();
vi.mock("@/server/env", () => ({ getServerSecret: (...a: unknown[]) => getServerSecret(...a) }));
const getTutorGender = vi.fn();
vi.mock("@/server/persona/queries", () => ({ getTutorGender: (...a: unknown[]) => getTutorGender(...a) }));
const resolveLessonVoiceTarget = vi.fn();
vi.mock("./lessonContext", async (importOriginal) => ({ ...(await importOriginal<typeof import("./lessonContext")>()), resolveLessonVoiceTarget: (...a: unknown[]) => resolveLessonVoiceTarget(...a) }));
const { manageVoice, voiceTurn, voiceActor } = await import("./service");
const { URGENT_REPLY_UK } = await import("@/server/safety/urgentReplyUk");
const audio = (type = "audio/webm", bytes = 10) => new File([new Uint8Array(bytes)], "turn.webm", { type });
beforeEach(() => {
  vi.clearAllMocks(); active = true; selectedVoice = null; queryLog.length = 0; updateLog.length = 0;
  lease = { id: ID, target: { kind: "friend", chatId: CHAT, revision: 2, voiceId: "shimmer" }, expires_at: "2030-10-21T12:01:00Z", ended_at: null, busy_until: BUSY };
  rpc.mockImplementation(() => ({ single: () => Promise.resolve({ data: lease, error: null }) }));
  getServerSecret.mockReturnValue("test-only-key");
  getFriendChat.mockResolvedValue({ id: CHAT, revision: 2 });
  getTutorGender.mockResolvedValue("f"); getBudgetState.mockResolvedValue("normal");
  transcribeAudio.mockResolvedValue({ result: "Чому знаменники різні?", audioSeconds: 3 });
  askFriendChat.mockResolvedValue({ ...message }); askTopicChat.mockResolvedValue({ ...message });
  callAudio.mockResolvedValue({ result: { audioBase64: "dGVzdA==", mimeType: "audio/mpeg" } });
  resolveLessonVoiceTarget.mockResolvedValue({ subjectId: "subject", topicId: "topic", sessionId: SESSION, context: "СЕРВЕРНИЙ ТЕКСТ КРОКУ" });
});

describe("voice admission", () => {
  it("requires a provider binding before starting a session", async () => {
    getServerSecret.mockReturnValue(null);
    await expect(manageVoice(actor, { target: { kind: "friend", chatId: CHAT } })).rejects.toThrow("voice_unavailable");
    expect(rpc).not.toHaveBeenCalled(); expect(callAudio).not.toHaveBeenCalled(); expect(transcribeAudio).not.toHaveBeenCalled();
  });
  it("refuses another child's or unavailable friend chat without allocating a session or calling providers", async () => {
    getFriendChat.mockRejectedValue(new Error("not_found"));
    await expect(manageVoice(actor, { target: { kind: "friend", chatId: CHAT } })).rejects.toThrow();
    expect(getFriendChat).toHaveBeenCalledWith(FAM, CHILD, CHAT); expect(rpc).not.toHaveBeenCalled(); expect(transcribeAudio).not.toHaveBeenCalled();
  });
  it.each(["budget", "hard_stop"])("blocks new sessions in %s budget state", async (state) => {
    getBudgetState.mockResolvedValue(state);
    await expect(manageVoice(actor, { target: { kind: "friend", chatId: CHAT } })).rejects.toThrow("voice_budget");
    expect(rpc).not.toHaveBeenCalled(); expect(callAudio).not.toHaveBeenCalled();
  });
  it("stores the server-owned revision and voice snapshot rather than client-injected voice metadata", async () => {
    await manageVoice(actor, { target: { kind: "friend", chatId: CHAT, voiceId: "attacker", revision: 999 } });
    expect(rpc).toHaveBeenCalledWith("manage_voice_session", { p_family_id: FAM, p_child_id: CHILD, p_target: { kind: "friend", chatId: CHAT, revision: 2, voiceId: "shimmer" } });
  });
  it("uses an allowed OpenAI voice from the child's selected catalogue entry", async () => {
    selectedVoice = { provider: "openai", provider_voice_id: "onyx" };
    await manageVoice({ ...actor, child: { ...actor.child, tutor_voice_id: "voice-id" } }, { target: { kind: "friend", chatId: CHAT } });
    expect(rpc.mock.calls[0]![1].p_target.voiceId).toBe("onyx");
  });
  it("permits stopping even after the budget or provider binding becomes unavailable", async () => {
    getServerSecret.mockReturnValue(null); getBudgetState.mockResolvedValue("hard_stop");
    await manageVoice(actor, { id: ID, action: "stop" });
    expect(rpc).toHaveBeenCalledWith("manage_voice_session", { p_family_id: FAM, p_child_id: CHILD, p_id: ID, p_stop: true });
    expect(getBudgetState).not.toHaveBeenCalled();
  });
});

describe("voice turn boundaries", () => {
  it.each([["text/plain", 10], ["audio/webm", 0], ["audio/webm", 1_000_001]])("rejects invalid audio %s/%s before STT", async (type, bytes) => {
    await expect(voiceTurn(actor, ID, audio(String(type), Number(bytes)))).rejects.toThrow("voice_audio");
    expect(rpc).not.toHaveBeenCalled(); expect(transcribeAudio).not.toHaveBeenCalled();
  });
  it("refuses a new turn when the provider binding disappeared after the lease was opened", async () => {
    getServerSecret.mockReturnValue(null);
    await expect(voiceTurn(actor, ID, audio())).rejects.toThrow("voice_unavailable");
    expect(rpc).not.toHaveBeenCalled(); expect(transcribeAudio).not.toHaveBeenCalled();
  });
  it("does not transcribe when the database denies the child-scoped session claim", async () => {
    rpc.mockImplementation(() => ({ single: () => Promise.resolve({ data: null, error: { message: "not_found" } }) }));
    await expect(voiceTurn(actor, ID, audio())).rejects.toThrow("voice_expired");
    expect(rpc).toHaveBeenCalledWith("claim_voice_turn", { p_family_id: FAM, p_child_id: CHILD, p_id: ID });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
  it("rejects a voice lease bound to a cleared friend-chat revision before STT", async () => {
    getFriendChat.mockResolvedValue({ id: CHAT, revision: 3 });
    await expect(voiceTurn(actor, ID, audio())).rejects.toThrow("voice_expired");
    expect(transcribeAudio).not.toHaveBeenCalled(); expect(askFriendChat).not.toHaveBeenCalled();
    expect(updateLog[0]).toMatchObject({ family: FAM, table: "voice_sessions", values: { busy_until: null } });
    expect(updateLog[0]!.filters).toEqual([["id", ID], ["child_profile_id", CHILD], ["busy_until", BUSY]]);
  });
  it("blocks friend voice at the monthly budget gate, then releases only the owned claim", async () => {
    getBudgetState.mockResolvedValue("budget");
    await expect(voiceTurn(actor, ID, audio())).rejects.toThrow("voice_budget");
    expect(transcribeAudio).not.toHaveBeenCalled(); expect(callAudio).not.toHaveBeenCalled(); expect(updateLog).toHaveLength(1);
  });
  it("closes overlong authoritative audio before any answer or TTS call", async () => {
    transcribeAudio.mockResolvedValue({ result: "довгий запис", audioSeconds: 30.1 });
    await expect(voiceTurn(actor, ID, audio())).rejects.toThrow("voice_audio");
    expect(rpc).toHaveBeenCalledWith("manage_voice_session", expect.objectContaining({ p_id: ID, p_stop: true }));
    expect(askFriendChat).not.toHaveBeenCalled(); expect(callAudio).not.toHaveBeenCalled();
  });
  it("returns silence without inventing or generating a reply", async () => {
    transcribeAudio.mockResolvedValue({ result: "   ", audioSeconds: 2 });
    expect(await voiceTurn(actor, ID, audio())).toEqual({ text: "" });
    expect(askFriendChat).not.toHaveBeenCalled(); expect(callAudio).not.toHaveBeenCalled();
  });
  it("rechecks the live session after transcription before asking the model", async () => {
    transcribeAudio.mockImplementation(async () => { active = false; return { result: "питання", audioSeconds: 2 }; });
    await expect(voiceTurn(actor, ID, audio())).rejects.toThrow("voice_expired");
    expect(askFriendChat).not.toHaveBeenCalled(); expect(callAudio).not.toHaveBeenCalled();
  });
  it("rechecks the friend revision after transcription so old audio cannot enter cleared context", async () => {
    getFriendChat.mockResolvedValueOnce({ id: CHAT, revision: 2 }).mockResolvedValue({ id: CHAT, revision: 3 });
    await expect(voiceTurn(actor, ID, audio())).rejects.toThrow("voice_expired");
    expect(askFriendChat).not.toHaveBeenCalled(); expect(callAudio).not.toHaveBeenCalled();
  });
  it("sends only the moderated answer to TTS and binds the friend write to the lease revision", async () => {
    const result = await voiceTurn(actor, ID, audio());
    expect(askFriendChat).toHaveBeenCalledWith(FAM, CHILD, "Зірочка", "Ліра", "f", "Чому знаменники різні?", CHAT, true, 2);
    expect(callAudio).toHaveBeenCalledWith("voice_reply", expect.objectContaining({ text: message.content, voiceId: "shimmer" }), expect.objectContaining({ familyId: FAM }));
    expect(result).toMatchObject({ text: "Чому знаменники різні?", message, endConversation: false });
    expect(updateLog[0]!.filters.at(-1)).toEqual(["busy_until", BUSY]);
  });
  it.each(["stop", "clear", "budget"])("keeps persisted text but avoids TTS when %s happens during generation", async (change) => {
    askFriendChat.mockImplementation(async () => {
      if (change === "stop") active = false;
      if (change === "clear") getFriendChat.mockResolvedValue({ id: CHAT, revision: 3 });
      if (change === "budget") getBudgetState.mockResolvedValue("budget");
      return { ...message };
    });
    expect(await voiceTurn(actor, ID, audio())).toMatchObject({ message, audio: null, endConversation: true });
    expect(callAudio).not.toHaveBeenCalled();
    expect(updateLog[0]!.filters.at(-1)).toEqual(["busy_until", BUSY]);
  });
  it("avoids speech when the lesson step changes during the answer", async () => {
    lease.target = { kind: "lesson", source: "session", sessionId: SESSION, stepId: STEP, voiceId: "shimmer" };
    askTopicChat.mockImplementation(async () => {
      resolveLessonVoiceTarget.mockRejectedValue(new Error("voice_lesson_unavailable"));
      return { ...message };
    });
    expect(await voiceTurn(actor, ID, audio())).toMatchObject({ message, audio: null, endConversation: true });
    expect(callAudio).not.toHaveBeenCalled();
  });
  it("keeps the persisted text reply when audio synthesis fails", async () => {
    callAudio.mockRejectedValue(new Error("provider failed"));
    expect(await voiceTurn(actor, ID, audio())).toMatchObject({ message, audio: null });
  });
  it("speaks only the deterministic urgent override and instructs the client to end the conversation", async () => {
    askFriendChat.mockResolvedValue({ ...message, content: URGENT_REPLY_UK });
    expect(await voiceTurn(actor, ID, audio())).toMatchObject({ endConversation: true, message: { content: URGENT_REPLY_UK } });
    expect(callAudio.mock.calls[0]![1].text).toBe(URGENT_REPLY_UK);
  });
  it("strips server voice metadata before strict lesson validation and uses server step context", async () => {
    lease.target = { kind: "lesson", source: "session", sessionId: SESSION, stepId: STEP, voiceId: "shimmer" };
    await voiceTurn(actor, ID, audio());
    expect(resolveLessonVoiceTarget).toHaveBeenCalledWith(FAM, CHILD, { kind: "lesson", source: "session", sessionId: SESSION, stepId: STEP });
    expect(askTopicChat).toHaveBeenCalledWith(FAM, CHILD, "Зірочка", "Ліра", "f", "subject", "Математика", "topic", "Дроби", "Чому знаменники різні?", SESSION, { voice: true, stepContext: "СЕРВЕРНИЙ ТЕКСТ КРОКУ" });
    expect(askFriendChat).not.toHaveBeenCalled();
  });
  it("loads the actor's child profile through the family scope", async () => {
    expect(await voiceActor(FAM)).toEqual(actor);
    expect(queryLog[0]).toMatchObject({ family: FAM, table: "child_profile" });
  });
});
