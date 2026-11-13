import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ audio: vi.fn(), language: "de-DE", owns: true, cached: null as null | Record<string, unknown> }));
vi.mock("@/server/auth/guards", () => ({ requireChild: async () => ({ ctx: { familyId: "family" } }) }));
vi.mock("@/server/ai/router", () => ({ callAudio: f.audio }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => { const q = { eq: () => q, maybeSingle: async () => ({ data: f.owns ? { id: "owned", content_tts: { lang: f.language } } : null }) }; return q; } }) }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: f.cached }), upsert: async (value: Record<string, unknown>) => { f.cached = value; return { error: null }; } }; return q; } }) }));
import { narrateLiteratureV3Action } from "./literature-v3";
const input = { refTable: "literature_v3_screens", refId: "11111111-1111-4111-8111-111111111111", field: "tts", text: "Name" };
beforeEach(() => { vi.clearAllMocks(); f.language = "de-DE"; f.owns = true; f.cached = null; f.audio.mockResolvedValue({ result: { audioBase64: "audio", mimeType: "audio/mpeg" } }); });
it("uses the stored language for TTS and invalidates cache when language changes even for identical text", async () => {
  expect((await narrateLiteratureV3Action(input)).status).toBe("ok"); expect(f.audio.mock.calls[0]![1].instructions).toContain("Deutsch");
  await narrateLiteratureV3Action(input); expect(f.audio).toHaveBeenCalledTimes(1);
  f.language = "en-GB"; await narrateLiteratureV3Action(input); expect(f.audio).toHaveBeenCalledTimes(2); expect(f.audio.mock.calls[1]![1].instructions).toContain("English");
});
it("does not synthesize or disclose a foreign row", async () => {
  f.owns = false; expect((await narrateLiteratureV3Action(input)).status).toBe("error"); expect(f.audio).not.toHaveBeenCalled();
});
