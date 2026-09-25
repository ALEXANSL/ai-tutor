import "server-only";
import { getServerSecret } from "../../env";
import { AiNotConfiguredError, ProviderError, type Usage } from "../types";

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
