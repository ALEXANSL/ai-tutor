import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ELEVENLABS_VOICE_ID, elevenLabsVoiceId, elevenlabsTts, isElevenLabsVoiceId } from "./elevenlabs";
import { AiNotConfiguredError, ProviderError } from "../types";

afterEach(() => vi.unstubAllEnvs());

describe("elevenlabsTts (ADR-049)", () => {
  it("refuses to call without a key", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    await expect(elevenlabsTts({ model: "eleven_multilingual_v2", text: "Привіт", params: {} }, vi.fn())).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it("sends only the text, model and voice, and returns mp3 bytes", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "secret-key");
    vi.stubEnv("ELEVENLABS_VOICE_ID", "AbCdEfGhIjKlMnOpQrSt");
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const { data } = await elevenlabsTts({ model: "eleven_multilingual_v2", text: "Дроби", voiceId: "alloy", params: {} }, fetchImpl as unknown as typeof fetch);
    expect(data).toEqual({ audioBase64: "AQID", mimeType: "audio/mpeg" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/AbCdEfGhIjKlMnOpQrSt?output_format=mp3_44100_128");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("secret-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ text: "Дроби", model_id: "eleven_multilingual_v2" });
  });

  it("maps an exhausted quota to a provider error so the router falls back", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "secret-key");
    const fetchImpl = vi.fn(async () => new Response("quota", { status: 401 }));
    await expect(elevenlabsTts({ model: "m", text: "Текст", params: {} }, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(ProviderError);
  });

  it("puts ElevenLabs' own reason into the error so the AI log shows why", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "secret-key");
    const body = JSON.stringify({ detail: { status: "missing_permissions", message: "The API key is missing the permission text_to_speech" } });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 401 }));
    await expect(elevenlabsTts({ model: "m", text: "Текст", params: {} }, fetchImpl as unknown as typeof fetch))
      .rejects.toThrow("elevenlabs tts error 401: missing_permissions — The API key is missing the permission text_to_speech");
  });
});

describe("voice selection", () => {
  it("accepts only ElevenLabs-shaped ids and otherwise uses the configured or default voice", () => {
    expect(isElevenLabsVoiceId("alloy")).toBe(false);
    expect(isElevenLabsVoiceId("AbCdEfGhIjKlMnOpQrSt")).toBe(true);
    vi.stubEnv("ELEVENLABS_VOICE_ID", "");
    expect(elevenLabsVoiceId("shimmer")).toBe(DEFAULT_ELEVENLABS_VOICE_ID);
    vi.stubEnv("ELEVENLABS_VOICE_ID", "ZyXwVuTsRqPoNmLkJiHg");
    expect(elevenLabsVoiceId()).toBe("ZyXwVuTsRqPoNmLkJiHg");
  });
});
