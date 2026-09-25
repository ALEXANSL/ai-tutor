import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { anthropicStructured, anthropicVisionStructured } from "./anthropic";
import { openaiEmbed } from "./openai";
import { AiNotConfiguredError, ProviderError } from "../types";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Mimics `client.messages.stream(...)` whose `.finalMessage()` resolves to `message`. */
function streamOf(message: unknown) {
  return vi.fn(() => ({ finalMessage: async () => message }));
}

describe("anthropicStructured (mocked SDK)", () => {
  const schema = z.object({ title: z.string() });
  const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it("sends model, effort and JSON schema; returns parsed output and usage", async () => {
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: { title: "Т" }, usage });
    const res = await anthropicStructured(
      { model: "claude-opus-5-5", system: "sys", prompt: "hi", schema, params: { effort: "medium", max_tokens: 9000 } },
      { messages: { stream: parse } } as never,
    );
    expect(res).toEqual({
      data: { title: "Т" },
      usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, cacheWriteTokens: 0 },
    });
    const [body] = parse.mock.calls[0]! as unknown as [{ output_config: { effort?: string; format?: unknown } }];
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 9000, system: "sys" });
    expect(body.output_config.effort).toBe("medium");
    expect(body.output_config.format).toBeDefined();
    // No sampling parameters or disabled thinking: rejected by current models.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
  });

  it("treats a refusal as a non-retryable provider error", async () => {
    const parse = streamOf({ stop_reason: "refusal", parsed_output: null, usage });
    await expect(
      anthropicStructured({ model: "m", system: "", prompt: "", schema, params: {} }, { messages: { stream: parse } } as never),
    ).rejects.toMatchObject({ name: "ProviderError", retryable: false });
  });

  it("reports a schema mismatch as a retryable provider error", async () => {
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: null, usage });
    await expect(
      anthropicStructured({ model: "m", system: "", prompt: "", schema, params: {} }, { messages: { stream: parse } } as never),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("needs ANTHROPIC_API_KEY when no client is injected", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(anthropicStructured({ model: "m", system: "", prompt: "", schema, params: {} })).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });
});

describe("anthropicVisionStructured (mocked SDK, D-54 OCR)", () => {
  const schema = z.object({ pages: z.array(z.object({ index: z.number(), text: z.string(), unreadable: z.boolean() })) });
  const usage = { input_tokens: 2000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it("puts the PDF document(s) before the text prompt, base64 as given", async () => {
    const answer = { pages: [{ index: 1, text: "Сторінка 1", unreadable: false }] };
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: answer, usage });
    const res = await anthropicVisionStructured(
      {
        model: "claude-sonnet-5",
        system: "sys",
        prompt: "Розпізнай сторінки",
        schema,
        params: { effort: "low" },
        documents: [{ mediaType: "application/pdf", data: "QkFTRTY0" }],
      },
      { messages: { stream: parse } } as never,
    );
    expect(res.data).toEqual(answer);
    const [body] = parse.mock.calls[0]! as unknown as [{ messages: { content: { type: string }[] }[] }];
    const content = body.messages[0]!.content;
    expect(content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QkFTRTY0" } });
    expect(content.at(-1)).toMatchObject({ type: "text", text: "Розпізнай сторінки" });
  });

  it("sends an image block for a non-PDF document", async () => {
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: { pages: [] }, usage });
    await anthropicVisionStructured(
      { model: "m", system: "", prompt: "p", schema, params: {}, documents: [{ mediaType: "image/png", data: "abc" }] },
      { messages: { stream: parse } } as never,
    );
    const [body] = parse.mock.calls[0]! as unknown as [{ messages: { content: { type: string }[] }[] }];
    expect(body.messages[0]!.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
  });

  it("reuses the same refusal/schema-mismatch handling as text-only calls", async () => {
    const parse = streamOf({ stop_reason: "refusal", parsed_output: null, usage });
    await expect(
      anthropicVisionStructured(
        { model: "m", system: "", prompt: "", schema, params: {}, documents: [] },
        { messages: { stream: parse } } as never,
      ),
    ).rejects.toMatchObject({ name: "ProviderError", retryable: false });
  });
});

describe("openaiEmbed (mocked fetch)", () => {
  it("requests 1536 dimensions and keeps the input order", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] },
          ],
          usage: { prompt_tokens: 7 },
        }),
        { status: 200 },
      ),
    );
    const res = await openaiEmbed({ model: "text-embedding-3-large", texts: ["a", "b"], dimensions: 1536 }, fetchMock);
    expect(res.vectors).toEqual([[1], [2]]);
    expect(res.usage.inputTokens).toBe(7);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(init.body)).toMatchObject({ model: "text-embedding-3-large", dimensions: 1536, input: ["a", "b"] });
  });

  it("maps HTTP errors without leaking the key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 429 }));
    const err = await openaiEmbed({ model: "m", texts: ["a"] }, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(String(err.message)).not.toContain("test-key-not-real");
  });

  it("is not configured without OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(openaiEmbed({ model: "m", texts: ["a"] }, vi.fn())).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});
