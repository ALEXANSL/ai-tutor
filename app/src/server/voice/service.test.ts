import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProfileRow } from "@/server/db/types";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
const m = vi.hoisted(() => ({ budget: vi.fn(), context: vi.fn(), gender: vi.fn(), seed: vi.fn(), create: vi.fn(), read: vi.fn(), renew: vi.fn(), stop: vi.fn(), claim: vi.fn(), release: vi.fn(), stt: vi.fn(), tts: vi.fn(), chat: vi.fn(), topicChat: vi.fn() }));
vi.mock("@/server/voice/lessonContext", async importOriginal => ({ ...await importOriginal<typeof import("./lessonContext")>(), resolveLessonVoiceTarget: m.context }));
vi.mock("@/server/voice/leases", () => ({ createLease: m.create, readLease: m.read, renewLease: m.renew, stopLease: m.stop, claimLease: m.claim, releaseLease: m.release }));
vi.mock("@/server/voice/config", () => ({ ensureLessonVoiceConfig: m.seed }));
vi.mock("@/server/ai/router", () => ({ transcribeAudio: m.stt, callAudio: m.tts }));
vi.mock("@/server/ai/store", () => ({ getBudgetState: m.budget }));
vi.mock("@/server/env", () => ({ getServerSecret: () => "test-key" }));
vi.mock("@/server/persona/queries", () => ({ getTutorGender: m.gender }));
vi.mock("@/server/lessons/chat", () => ({ askTopicChat: m.chat, getOrCreateTopicChat: m.topicChat }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => ({ familyId, select: (table: string) => {
  const self = { eq: () => self, maybeSingle: async () => ({ data: table === "subjects" ? { name_uk: "Географія" } : table === "topics" ? { title: "Форма Землі" } : null }) }; return self;
} }) }));
const { manageVoice, voiceTurn } = await import("./service");
const id = "10000000-0000-4000-8000-000000000001";
const actor = { familyId: "family", child: { id: "child", nickname: "Зірочка", tutor_name: "Ліра" } as ChildProfileRow };
const target = { kind: "chapter" as const, lessonId: id, stepId: "screen" };
const lease = { id, target: { ...target, voiceId: "shimmer" }, expires_at: "2030-01-01T00:00:00.000Z", claim: "claim" };
const context = { subjectId: "geography", topicId: "earth", context: "Полярний радіус менший за екваторіальний" };
const audio = new File(["audio"], "voice.webm", { type: "audio/webm" });
const answer = { id: "message", author: "ai", content: "Земля сплюснута біля полюсів.", createdAt: "2026-10-21T00:00:00Z" };
beforeEach(() => {
  vi.resetAllMocks(); m.budget.mockResolvedValue("normal"); m.context.mockResolvedValue(context); m.gender.mockResolvedValue("f"); m.seed.mockResolvedValue(undefined);
  for (const f of [m.create, m.read, m.renew, m.stop, m.claim]) f.mockResolvedValue(lease);
  m.release.mockResolvedValue(undefined); m.topicChat.mockResolvedValue("chat"); m.stt.mockResolvedValue({ result: "Чому до полюса ближче?", audioSeconds: 4 });
  m.chat.mockResolvedValue(answer); m.tts.mockResolvedValue({ result: { audioBase64: "AAAA", mimeType: "audio/mpeg" } });
});
describe("lesson voice orchestration", () => {
  it("starts only with trusted context, allowed budget and configured routes", async () => {
    expect(await manageVoice(actor, { target })).toEqual({ id, expiresAt: lease.expires_at });
    expect(m.context).toHaveBeenCalledWith("family", "child", target); expect(m.seed).toHaveBeenCalledWith("family");
    expect(m.create.mock.calls[0]!.slice(1)).toEqual(["child", "chat", { ...target, voiceId: "shimmer" }]);
  });
  it("rejects forged context and new starts after budget exhaustion", async () => {
    await expect(manageVoice(actor, { target: { ...target, context: "forged" } })).rejects.toThrow();
    m.budget.mockResolvedValue("budget"); await expect(manageVoice(actor, { target })).rejects.toThrow("voice_budget"); expect(m.create).not.toHaveBeenCalled();
  });
  it("allows stopping after budget exhaustion without resolving content", async () => {
    m.budget.mockResolvedValue("hard_stop"); await expect(manageVoice(actor, { id, action: "stop" })).resolves.toMatchObject({ id }); expect(m.context).not.toHaveBeenCalled();
  });
  it("lets an ongoing lesson continue in budget mode without daily duration limits", async () => {
    m.budget.mockResolvedValue("budget"); await expect(manageVoice(actor, { id, action: "renew" })).resolves.toMatchObject({ id }); expect(m.renew).toHaveBeenCalled();
  });
  it("transcribes then speaks the moderated answer using server lesson context", async () => {
    expect(await voiceTurn(actor, id, audio)).toMatchObject({ text: "Чому до полюса ближче?", message: answer, audio: { audioBase64: "AAAA" }, endConversation: false });
    expect(m.chat.mock.calls[0]!.slice(-2)).toEqual([undefined, { voice: true, stepContext: context.context }]);
    expect(m.tts).toHaveBeenCalledWith("voice_reply", expect.objectContaining({ text: answer.content, voiceId: "shimmer" }), expect.objectContaining({ familyId: "family", ref: { table: "messages", id } }));
    expect(m.release.mock.calls[0]!.slice(1)).toEqual(["child", id, "claim"]);
  });
  it.each([new File([], "empty.webm", { type: "audio/webm" }), new File([new Uint8Array(1_000_001)], "big.webm", { type: "audio/webm" }), new File(["text"], "text.txt", { type: "text/plain" })])("rejects invalid audio before claiming or paid calls", async file => {
    await expect(voiceTurn(actor, id, file)).rejects.toThrow("voice_audio"); expect(m.claim).not.toHaveBeenCalled(); expect(m.stt).not.toHaveBeenCalled();
  });
  it("rejects confirmed long audio after accounting for transcription", async () => {
    m.stt.mockResolvedValue({ result: "Long", audioSeconds: 31 }); await expect(voiceTurn(actor, id, audio)).rejects.toThrow("voice_audio"); expect(m.stop).toHaveBeenCalled(); expect(m.chat).not.toHaveBeenCalled(); expect(m.release).toHaveBeenCalled();
  });
  it("does not generate a reply after stop during transcription", async () => {
    m.read.mockResolvedValueOnce(lease).mockRejectedValue(new Error("voice_expired")); await expect(voiceTurn(actor, id, audio)).rejects.toThrow("voice_expired"); expect(m.chat).not.toHaveBeenCalled(); expect(m.tts).not.toHaveBeenCalled();
  });
  it("does not start speech after stop during reply generation", async () => {
    m.read.mockResolvedValueOnce(lease).mockResolvedValueOnce(lease).mockRejectedValue(new Error("voice_expired"));
    expect(await voiceTurn(actor, id, audio)).toMatchObject({ message: answer, audio: null, endConversation: true }); expect(m.tts).not.toHaveBeenCalled();
  });
  it("preserves the text when speech generation fails", async () => {
    m.tts.mockRejectedValue(new Error("provider down")); expect(await voiceTurn(actor, id, audio)).toMatchObject({ message: answer, audio: null });
  });
  it("ends on the deterministic urgent safety reply", async () => {
    m.chat.mockResolvedValue({ ...answer, content: URGENT_REPLY_UK }); expect(await voiceTurn(actor, id, audio)).toMatchObject({ endConversation: true }); expect(m.tts.mock.calls[0]![1].text).toBe(URGENT_REPLY_UK);
  });
  it("does not fabricate a reply for empty recognized speech", async () => {
    m.stt.mockResolvedValue({ result: "  ", audioSeconds: 1 }); expect(await voiceTurn(actor, id, audio)).toEqual({ text: "" }); expect(m.chat).not.toHaveBeenCalled(); expect(m.release).toHaveBeenCalled();
  });
});
