import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BudgetBlockedError } from "@/server/ai/types";
import { FriendChatChangedError } from "@/server/lessons/friendChat";
import { sameOrigin, voiceError } from "./http";

const requireLessonAccess = vi.fn(); const manageVoice = vi.fn(); const voiceActor = vi.fn(); const voiceTurn = vi.fn();
vi.mock("@/server/auth/guards", () => ({ requireLessonAccess: (...a: unknown[]) => requireLessonAccess(...a) }));
vi.mock("@/server/voice/service", () => ({ manageVoice: (...a: unknown[]) => manageVoice(...a), voiceActor: (...a: unknown[]) => voiceActor(...a), voiceTurn: (...a: unknown[]) => voiceTurn(...a) }));
const { POST: sessionPOST } = await import("@/app/api/voice/session/route");
const { POST: turnPOST } = await import("@/app/api/voice/turn/route");
const origin = "https://tutor.example";
const actor = { familyId: "auth-family", child: { id: "auth-child" } };
function request(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method: "POST", body, headers: { origin, ...headers } });
}
beforeEach(() => {
  vi.resetAllMocks(); requireLessonAccess.mockResolvedValue({ familyId: "auth-family" });
  voiceActor.mockResolvedValue(actor); manageVoice.mockResolvedValue({ id: "lease", expiresAt: "future" });
  voiceTurn.mockResolvedValue({ text: "" });
});

describe("voice same-origin protection", () => {
  it.each([
    [origin, true], ["https://tutor.example.attacker.test", false], ["http://tutor.example", false], ["https://tutor.example:8443", false], ["null", false], ["", false],
  ])("origin %s allowed=%s", (header, expected) => {
    expect(sameOrigin(new Request(origin + "/api/voice/session", { headers: header ? { origin: String(header) } : {} }))).toBe(expected);
  });
  it.each(["session", "turn"])("rejects cross-origin %s before authentication or service calls", async (endpoint) => {
    const response = await (endpoint === "session" ? sessionPOST : turnPOST)(request(`/api/voice/${endpoint}`, "{}", { origin: "https://attacker.test" }));
    expect(response.status).toBe(403); expect(requireLessonAccess).not.toHaveBeenCalled();
    expect(voiceActor).not.toHaveBeenCalled(); expect(manageVoice).not.toHaveBeenCalled(); expect(voiceTurn).not.toHaveBeenCalled();
  });
});

describe("voice route input and authority", () => {
  it("uses the authenticated family to resolve the actor, ignoring forged family/child fields", async () => {
    await sessionPOST(request("/api/voice/session", JSON.stringify({ target: { kind: "friend", chatId: "chat" }, familyId: "forged", childId: "forged" }), { "content-type": "application/json" }));
    expect(voiceActor).toHaveBeenCalledWith("auth-family");
    expect(manageVoice.mock.calls[0]![0]).toBe(actor);
  });
  it("does not invoke the service when authentication redirects the visitor", async () => {
    requireLessonAccess.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(sessionPOST(request("/api/voice/session", "{}"))).rejects.toThrow("NEXT_REDIRECT");
    expect(voiceActor).not.toHaveBeenCalled(); expect(manageVoice).not.toHaveBeenCalled();
  });
  it("rejects a declared oversized multipart request before reading data or resolving the child", async () => {
    const response = await turnPOST(request("/api/voice/turn", "oversized", { "content-length": "1100001" }));
    expect(response.status).toBe(400); expect(voiceActor).not.toHaveBeenCalled(); expect(voiceTurn).not.toHaveBeenCalled();
  });
  it("rejects a text field masquerading as the audio file", async () => {
    const form = new FormData(); form.set("id", "lease"); form.set("audio", "not an audio file");
    const response = await turnPOST(request("/api/voice/turn", form));
    expect(response.status).toBe(400); expect(voiceActor).not.toHaveBeenCalled(); expect(voiceTurn).not.toHaveBeenCalled();
  });
  it("forwards an actual audio file with the server-resolved actor", async () => {
    const form = new FormData(); form.set("id", "lease"); form.set("audio", new File(["test"], "turn.webm", { type: "audio/webm" }));
    const response = await turnPOST(request("/api/voice/turn", form));
    expect(response.status).toBe(200); expect(voiceActor).toHaveBeenCalledWith("auth-family");
    expect(voiceTurn).toHaveBeenCalledWith(actor, "lease", expect.any(File));
  });
});

describe("safe voice error responses", () => {
  it.each([
    [new Error("voice_limit"), "voice_limit", 429], [new Error("voice_budget"), "voice_budget", 429],
    [new Error("voice_expired"), "voice_expired", 409], [new Error("voice_audio"), "voice_audio", 400],
    [new Error("voice_lesson_unavailable"), "voice_expired", 409], [new FriendChatChangedError(), "voice_expired", 409],
    [new BudgetBlockedError("deferred", "voice_reply"), "voice_budget", 429],
  ])("maps known errors to child-facing codes", async (error, code, status) => {
    const response = voiceError(error); expect(response.status).toBe(status);
    const body = await response.json(); expect(body.error).toBe(code); expect(body.message.length).toBeGreaterThan(15);
  });
  it("does not expose provider failures, credential values or stack details", async () => {
    const response = voiceError(new Error("upstream sensitive-test-credential internal://host"));
    expect(response.status).toBe(409); const text = await response.text();
    expect(text).not.toContain("sensitive-test-credential"); expect(text).not.toContain("internal://host");
    expect(JSON.parse(text).error).toBe("voice_unavailable");
  });
  it("reports invalid schema input without reflecting submitted values", async () => {
    const invalid = z.string().uuid().safeParse("sensitive-invalid-input");
    const response = voiceError(invalid.error); expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("sensitive-invalid-input");
  });
});
