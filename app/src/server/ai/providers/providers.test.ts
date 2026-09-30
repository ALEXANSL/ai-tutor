import { afterEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropicStructured, anthropicVisionStructured } from "./anthropic";
import { openaiEmbed, openaiStructured, openaiTts } from "./openai";
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
    // ADR-033: system is now sent as one cache_control-marked text block (see the dedicated tests below).
    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 9000 });
    expect(body.output_config.effort).toBe("medium");
    expect(body.output_config.format).toBeDefined();
    // No sampling parameters or disabled thinking: rejected by current models.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
  });

  it("captures cache read/write token counts from the SDK response (ADR-033)", async () => {
    const usageWithCache = { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1500 };
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: { title: "Т" }, usage: usageWithCache });
    const res = await anthropicStructured(
      { model: "m", system: "s", prompt: "p", schema, params: {} },
      { messages: { stream: parse } } as never,
    );
    expect(res.usage).toEqual({ inputTokens: 300, outputTokens: 50, cachedInputTokens: 9000, cacheWriteTokens: 1500 });
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

  /**
   * Prod incident 2026-09-28 (Bug 2): jobs failed with a bare "anthropic
   * request error 400" and NOTHING else in `jobs.last_error` (truncated to
   * 500 chars in the DB, but there was no further detail even to truncate).
   * A 400 from the Anthropic client always carries the actual API response
   * body on `.error` — it must now be logged in full so a future 400 is
   * never a dead end.
   */
  it("logs the full response body of a 400 before wrapping it (Bug 2, 2026-09-28)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = { type: "invalid_request_error", message: "schema too complex: too many nested optional fields" };
    const badRequest = new Anthropic.BadRequestError(400, body, "bad request", undefined as unknown as Headers);
    const stream = vi.fn(() => ({
      finalMessage: () => {
        throw badRequest;
      },
    }));
    const err = await anthropicStructured(
      { model: "m", system: "", prompt: "", schema, params: {} },
      { messages: { stream } } as never,
    ).catch((e) => e);
    expect(err).toMatchObject({ name: "ProviderError", retryable: false });
    expect((err as Error).message).toContain("anthropic request error 400");
    // 2026-09-30: the thrown message now carries a slice of the real detail
    // too — not just the console log — so a caller that surfaces it (e.g.
    // the literature-extraction admin panel) isn't stuck with a bare status code.
    expect((err as Error).message).toContain("schema too complex");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("anthropic request error 400"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("schema too complex"));
    spy.mockRestore();
  });

  it("needs ANTHROPIC_API_KEY when no client is injected", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(anthropicStructured({ model: "m", system: "", prompt: "", schema, params: {} })).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });

  /**
   * ADR-033 item 3: every Anthropic call's system prompt gets ONE
   * `cache_control` breakpoint — the cheap, systemwide win, applied here in
   * the provider wrapper rather than at each of the ~10 call sites.
   */
  it("marks the system prompt with an ephemeral cache_control breakpoint (ADR-033)", async () => {
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: { title: "Т" }, usage });
    await anthropicStructured(
      { model: "m", system: "статичний системний промпт", prompt: "p", schema, params: {} },
      { messages: { stream: parse } } as never,
    );
    const [body] = parse.mock.calls[0]! as unknown as [{ system: unknown }];
    expect(body.system).toEqual([{ type: "text", text: "статичний системний промпт", cache_control: { type: "ephemeral" } }]);
  });

  it("sends no system field at all for an empty system prompt (no empty cache block)", async () => {
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: { title: "Т" }, usage });
    await anthropicStructured({ model: "m", system: "", prompt: "p", schema, params: {} }, { messages: { stream: parse } } as never);
    const [body] = parse.mock.calls[0]! as unknown as [{ system: unknown }];
    expect(body.system).toBeUndefined();
  });

  /**
   * ADR-033 item 1: `lesson_generation`'s pipeline builds `prompt` as a
   * two-block array (shared, cacheable prefix + dynamic revision notes) —
   * this is the boundary that turns those blocks into the SDK's content
   * shape, carrying `cache_control` through on the marked block only.
   */
  it("turns a PromptContent block list into Anthropic text content blocks, cache_control included (ADR-033)", async () => {
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: { title: "Т" }, usage });
    await anthropicStructured(
      {
        model: "m",
        system: "sys",
        prompt: [
          { type: "text", text: "статична частина (план + фрагменти)", cache_control: { type: "ephemeral" } },
          { type: "text", text: "зауваження рецензента (динамічне)" },
        ],
        schema,
        params: {},
      },
      { messages: { stream: parse } } as never,
    );
    const [body] = parse.mock.calls[0]! as unknown as [{ messages: { content: unknown }[] }];
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: "статична частина (план + фрагменти)", cache_control: { type: "ephemeral" } },
      { type: "text", text: "зауваження рецензента (динамічне)" },
    ]);
  });

  it("still sends a plain string prompt unchanged (every role but lesson_generation)", async () => {
    const parse = streamOf({ stop_reason: "end_turn", parsed_output: { title: "Т" }, usage });
    await anthropicStructured({ model: "m", system: "sys", prompt: "hi", schema, params: {} }, { messages: { stream: parse } } as never);
    const [body] = parse.mock.calls[0]! as unknown as [{ messages: { content: unknown }[] }];
    expect(body.messages[0]!.content).toBe("hi");
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

describe("openaiTts (mocked fetch)", () => {
  it("requests a 10% faster speed (D-111 п.5) and returns base64 audio", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const res = await openaiTts({ model: "gpt-4o-mini-tts", text: "Привіт", params: {} }, fetchMock);
    expect(res.data.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(res.data.audioBase64, "base64")).toEqual(Buffer.from([1, 2, 3]));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(init.body)).toMatchObject({ model: "gpt-4o-mini-tts", input: "Привіт", speed: 1.1 });
  });

  it("rejects empty text without calling the API", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn();
    await expect(openaiTts({ model: "m", text: "   ", params: {} }, fetchMock)).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not configured without OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(openaiTts({ model: "m", text: "a", params: {} }, vi.fn())).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe("openaiStructured (mocked fetch, ADR-022: lesson_review, a DIFFERENT provider)", () => {
  const schema = z.object({ verdict: z.enum(["approved", "revise"]), notes: z.array(z.string()) });

  it("sends a strict JSON schema (additionalProperties: false, all fields required) and parses the result", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({ verdict: "approved", notes: [] }),
          usage: { input_tokens: 900, output_tokens: 120, input_tokens_details: { cached_tokens: 0 } },
        }),
        { status: 200 },
      ),
    );
    const res = await openaiStructured(
      { model: "gpt-5.6-sol", system: "sys", prompt: "review this", schema, params: { effort: "medium", max_tokens: 4000 } },
      fetchMock,
    );
    expect(res).toEqual({
      data: { verdict: "approved", notes: [] },
      usage: { inputTokens: 900, outputTokens: 120, cachedInputTokens: 0 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "gpt-5.6-sol", instructions: "sys", input: "review this" });
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.text.format.schema.required).toEqual(Object.keys(body.text.format.schema.properties));
  });

  it("rejects a response whose JSON does not match the schema (retryable)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({ verdict: "not-a-verdict" }) }), { status: 200 }));
    const err = await openaiStructured({ model: "m", system: "", prompt: "", schema, params: {} }, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });

  it("maps HTTP errors without leaking the key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    const err = await openaiStructured({ model: "m", system: "", prompt: "", schema, params: {} }, fetchMock).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(String(err.message)).not.toContain("test-key-not-real");
  });

  it("is not configured without OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(openaiStructured({ model: "m", system: "", prompt: "", schema, params: {} }, vi.fn())).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});
