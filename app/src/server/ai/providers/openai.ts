import "server-only";
import { z } from "zod";
import { getServerSecret } from "../../env";
import { AiNotConfiguredError, ProviderError, type RouteParams, type Usage } from "../types";

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
  prompt: string;
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

  let res: Response;
  try {
    res = await fetchImpl(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: req.model,
        instructions: req.system,
        input: req.prompt,
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
