import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiTranscribe } from "./openai";
import { AiNotConfiguredError } from "../types";

const audio = new File([new Uint8Array([1, 2, 3])], "utterance.webm", { type: "audio/webm" });
beforeEach(() => { vi.stubEnv("OPENAI_API_KEY", "test-openai-transcription-key"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("OpenAI transcription protocol (mock fetch, no paid API calls)", () => {
  it("uploads multipart audio with the UA language and lets fetch set the multipart boundary", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: "  Поясни, будь ласка  ", duration: 12.3 }), { status: 200 }));
    const result = await openaiTranscribe({ model: "whisper-1", audio, params: { timeout_ms: 1000 } }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(options?.method).toBe("POST");
    const headers = new Headers(options?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-openai-transcription-key");
    expect(headers.has("content-type")).toBe(false);
    const form = options?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file.name).toBe("utterance.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(audio.size);
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("uk");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ data: "Поясни, будь ласка", usage: { inputTokens: 13, outputTokens: 0 } });
  });

  it("returns the provider's long duration for billing and service-level length rejection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: "Довге питання", duration: 90.2 })));
    expect((await openaiTranscribe({ model: "whisper-1", audio, params: {} }, fetcher)).usage).toEqual({ inputTokens: 91, outputTokens: 0 });
  });

  it.each([401, 429, 500])("wraps HTTP %s without including response text or secrets", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private provider response", { status }));
    const error = await openaiTranscribe({ model: "whisper-1", audio, params: {} }, fetcher).catch((e: unknown) => e) as Error;
    expect(error).toMatchObject({ name: "ProviderError", status, retryable: status === 429 || status >= 500 });
    expect(error.message).not.toContain("private provider response");
    expect(error.message).not.toContain("test-openai-transcription-key");
  });

  it("turns a network failure into a retryable provider failure without logging audio", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("private upstream details"));
    await expect(openaiTranscribe({ model: "whisper-1", audio, params: {} }, fetcher)).rejects.toMatchObject({ name: "ProviderError", status: null, retryable: true, message: "openai transcription network error" });
  });

  it("never contacts the provider without the required key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetcher = vi.fn<typeof fetch>();
    await expect(openaiTranscribe({ model: "whisper-1", audio, params: {} }, fetcher)).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ text: "hello" }, { text: "hello", duration: -1 }, { text: 42, duration: 1 }])("rejects an invalid duration/transcript response: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(openaiTranscribe({ model: "whisper-1", audio, params: {} }, fetcher)).rejects.toThrow();
  });
});
