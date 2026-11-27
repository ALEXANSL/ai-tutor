import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const tts = vi.hoisted(() => ({ impl: async (): Promise<unknown> => ({}) }));
vi.mock("./elevenlabs", () => ({ DEFAULT_ELEVENLABS_MODEL: "eleven_multilingual_v2", elevenlabsTts: () => tts.impl() }));

import { ProviderError } from "../types";
import { checkElevenLabs, elevenLabsHint } from "./elevenlabs-check";

describe("elevenLabsHint", () => {
  it("names the concrete fix for each common refusal", () => {
    expect(elevenLabsHint(401, "missing_permissions — needs text_to_speech")).toMatch(/Text to Speech/);
    expect(elevenLabsHint(404, "voice_not_found — A voice with that ID does not exist")).toMatch(/Add to my voices/);
    expect(elevenLabsHint(402, "paid_plan_required")).toMatch(/ліміт|тариф/);
    expect(elevenLabsHint(401, "invalid_api_key")).toMatch(/ключ наново/);
    expect(elevenLabsHint(401, "detected_unusual_activity")).toMatch(/платний тариф/);
    expect(elevenLabsHint(503, "")).toMatch(/збій/);
  });
});

describe("checkElevenLabs", () => {
  it("reports a missing key without calling ElevenLabs", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(await checkElevenLabs()).toEqual({ state: "no_key" });
  });

  it("returns ok or the status, reason and hint of a refusal", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "k");
    tts.impl = async () => ({});
    expect(await checkElevenLabs()).toEqual({ state: "ok" });
    tts.impl = async () => { throw new ProviderError("elevenlabs tts error 404: voice_not_found — no such voice", "elevenlabs", 404, false); };
    const result = await checkElevenLabs();
    expect(result).toMatchObject({ state: "error", status: 404, reason: "voice_not_found — no such voice" });
  });
});
