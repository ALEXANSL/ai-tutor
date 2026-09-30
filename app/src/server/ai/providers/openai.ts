import "server-only";
import { z } from "zod";
import { getServerSecret } from "../../env";
import { AiNotConfiguredError, ProviderError, type AudioResult, type PromptContent, type RouteParams, type Usage } from "../types";

export interface EmbedRequest {
  model: string;
  texts: string[];
  dimensions?: number;
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
  usage: Usage;
}

const ENDPOINT = "https://api.openai.com/v1/embeddings";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const MODERATIONS_ENDPOINT = "https://api.openai.com/v1/moderations";

export interface OmniModerationResult {
  flagged: boolean;
  categories: string[];
}

/**
 * ADR-009 layer 1: OpenAI `omni-moderation` — free, fast, general categories
 * (self-harm, violence, …). Not routed through `model_routes` (it is not a
 * model choice, it is a fixed classifier endpoint always called first) and
 * not billed (docs/02 7.3: "$0"); a failure here never blocks layer 2 or the
 * child's reply — the caller treats a thrown error as "not flagged by layer
 * 1" and still runs the Haiku classifier (ADR-009: three providers in the
 * chain, one being down never stops moderation).
 */
export async function openaiModerate(text: string, fetchImpl: typeof fetch = fetch): Promise<OmniModerationResult> {
  const key = getServerSecret("OPENAI_API_KEY");
  if (!key) throw new AiNotConfiguredError("OPENAI_API_KEY is not set");
  let res: Response;
  try {
    res = await fetchImpl(MODERATIONS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new ProviderError(`openai network error: ${(e as Error).name}`, "openai", null, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(`openai moderations error ${res.status}`, "openai", res.status, retryable);
  }
  const body = (await res.json()) as {
    results?: { flagged?: boolean; categories?: Record<string, boolean> }[];
  };
  const result = body.results?.[0];
  const categories = Object.entries(result?.categories ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  return { flagged: result?.flagged ?? false, categories };
}

/**
 * OpenAI embeddings (docs/02 7.3: text-embedding-3-large, 1536 dimensions).
 * Paid API — data is not used for training (NFR-PRIV-1, docs/02 7.1).
 */
export async function openaiEmbed(req: EmbedRequest, fetchImpl: typeof fetch = fetch): Promise<EmbedResult> {
  const key = getServerSecret("OPENAI_API_KEY");
  if (!key) throw new AiNotConfiguredError("OPENAI_API_KEY is not set");
  if (req.texts.length === 0) return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 } };

  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: req.model,
        input: req.texts,
        encoding_format: "float",
        ...(req.dimensions ? { dimensions: req.dimensions } : {}),
      }),
      signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
    });
  } catch (e) {
    throw new ProviderError(`openai network error: ${(e as Error).name}`, "openai", null, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(`openai embeddings error ${res.status}`, "openai", res.status, retryable);
  }
  const body = (await res.json()) as {
    data?: { index: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number };
  };
  const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
  if (data.length !== req.texts.length) {
    throw new ProviderError("openai embeddings: unexpected response size", "openai", res.status, true);
  }
  return {
    vectors: data.map((d) => d.embedding),
    usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: 0 },
  };
}

export interface OpenAiStructuredRequest<S extends z.ZodType> {
  model: string;
  system: string;
  /**
   * ADR-033: the shared `ProviderAdapters.structured` router type also
   * allows a cacheable block list (used today only for the Anthropic-routed
   * `lesson_generation` role). OpenAI has no `cache_control` concept — a
   * block list is flattened to plain text below; caching there is unaffected
   * either way (ADR-033: OpenAI caches automatically on an identical prefix,
   * no code change needed).
   */
  prompt: PromptContent;
  schema: S;
  params: RouteParams;
}

export interface OpenAiStructuredResult<T> {
  data: T;
  usage: Usage;
}

/**
 * OpenAI Structured Outputs are "strict": every object needs
 * `additionalProperties: false` and every declared property listed in
 * `required` (optional fields are expressed as `type: [T, "null"]`, already
 * how zod v4's `.nullable()`/`.optional()` come out of `z.toJSONSchema`).
 * This walks the schema zod produced and only adds what strict mode needs —
 * it does not change field types.
 */
function toStrictJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictJsonSchema);
  if (!node || typeof node !== "object") return node;
  const obj = { ...(node as Record<string, unknown>) };
  for (const [k, v] of Object.entries(obj)) obj[k] = toStrictJsonSchema(v);
  if (obj.type === "object" || obj.properties) {
    obj.additionalProperties = false;
    const props = (obj.properties ?? {}) as Record<string, unknown>;
    obj.required = Object.keys(props);
  }
  return obj;
}

/**
 * One structured (JSON-schema) call to an OpenAI model via the Responses API
 * (`lesson_review`, ADR-022: the required *different provider* from Claude,
 * which does `lesson_planning`/`lesson_generation`). Uses `fetch` directly,
 * like `openaiEmbed` above — no OpenAI SDK dependency needed for one call
 * shape, and it keeps this adapter mockable the same way in tests.
 */
export async function openaiStructured<S extends z.ZodType>(
  req: OpenAiStructuredRequest<S>,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenAiStructuredResult<z.infer<S>>> {
  const key = getServerSecret("OPENAI_API_KEY");
  if (!key) throw new AiNotConfiguredError("OPENAI_API_KEY is not set");

  const jsonSchema = toStrictJsonSchema(z.toJSONSchema(req.schema, { target: "draft-7", io: "output" }));
  const input = typeof req.prompt === "string" ? req.prompt : req.prompt.map((b) => b.text).join("\n\n");

  let res: Response;
  try {
    res = await fetchImpl(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: req.model,
        instructions: req.system,
        input,
        ...(req.params.effort ? { reasoning: { effort: req.params.effort === "xhigh" || req.params.effort === "max" ? "high" : req.params.effort } } : {}),
        max_output_tokens: req.params.max_tokens ?? 16000,
        text: { format: { type: "json_schema", name: "response", strict: true, schema: jsonSchema } },
      }),
      signal: AbortSignal.timeout(req.params.timeout_ms ?? 120_000),
    });
  } catch (e) {
    throw new ProviderError(`openai network error: ${(e as Error).name}`, "openai", null, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(`openai responses error ${res.status}`, "openai", res.status, retryable);
  }
  const body = (await res.json()) as {
    status?: string;
    output_text?: string;
    output?: { content?: { type: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
  if (body.status === "incomplete") {
    throw new ProviderError("openai response incomplete (max_output_tokens?)", "openai", res.status, true);
  }
  const text =
    body.output_text ??
    body.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text" || c.type === "text")?.text ??
    null;
  if (!text) throw new ProviderError("openai response had no text output", "openai", res.status, true);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("openai structured output was not valid JSON", "openai", res.status, true);
  }
  const validated = req.schema.safeParse(parsed);
  if (!validated.success) {
    throw new ProviderError(`openai structured output did not match the schema: ${validated.error.issues[0]?.message ?? "invalid"}`, "openai", res.status, true);
  }
  return {
    data: validated.data as z.infer<S>,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      cachedInputTokens: body.usage?.input_tokens_details?.cached_tokens ?? 0,
    },
  };
}

const TTS_ENDPOINT = "https://api.openai.com/v1/audio/speech";

export interface OpenAiTtsRequest {
  model: string;
  text: string;
  voiceId?: string;
  params: RouteParams;
}

/**
 * Passive narration (role `passive_narration`, ADR-025): reads already-
 * generated step text aloud ("почитай мені параграф") — never the tutor's
 * own live-voice persona (ADR-006, `tts` role). `gpt-4o-mini-tts` supports a
 * tone `instructions` string; ADR-025 §Рішення asks for "тепло й спокійно,
 * як аудіокнига". The endpoint streams raw audio bytes with no usage in the
 * response — `router.ts`'s `callAudio` fills in `usage.inputTokens` from
 * `text.length` for the cost estimate (see the S5 seed migration comment on
 * `model_prices` for why that column is priced per character, not token).
 */
export async function openaiTts(req: OpenAiTtsRequest, fetchImpl: typeof fetch = fetch): Promise<{ data: AudioResult; usage: Usage }> {
  const key = getServerSecret("OPENAI_API_KEY");
  if (!key) throw new AiNotConfiguredError("OPENAI_API_KEY is not set");
  if (!req.text.trim()) throw new ProviderError("openai tts: empty text", "openai", null, false);

  let res: Response;
  try {
    res = await fetchImpl(TTS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: req.model,
        input: req.text,
        voice: req.voiceId ?? "alloy",
        instructions: "Читай тепло й спокійно, українською, як аудіокнигу — не як озвучений слайд.",
        response_format: "mp3",
        // D-111 п.5: PO reported narration felt too slow and asked for
        // ~10-15% faster; the API supports 0.25-4.0 (default 1.0) but this
        // was never passed. ADR-025 has no existing guidance on `speed`, so
        // this picks 1.1 (10% faster), the low end of the PO's own range —
        // the client-side `playbackRate` control (`NarrationPlayer`) lets
        // each listener go faster still on top of this baseline.
        speed: 1.1,
      }),
      signal: AbortSignal.timeout(req.params.timeout_ms ?? 30_000),
    });
  } catch (e) {
    throw new ProviderError(`openai network error: ${(e as Error).name}`, "openai", null, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(`openai tts error ${res.status}`, "openai", res.status, retryable);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    data: { audioBase64: bytes.toString("base64"), mimeType: "audio/mpeg" },
    // No usage in this endpoint's response — approximated by the caller
    // (`callAudio`) from character count; left at 0 here so a direct unit
    // test of this function alone doesn't imply a false usage number.
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
