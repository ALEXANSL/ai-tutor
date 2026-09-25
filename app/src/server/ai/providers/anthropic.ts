import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { getServerSecret } from "../../env";
import { AiNotConfiguredError, ProviderError, type RouteParams, type Usage, type VisionDocument } from "../types";

export interface StructuredRequest<S extends z.ZodType> {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  params: RouteParams;
}

/** Same as `StructuredRequest`, plus page images/PDFs to OCR (D-54). */
export interface VisionStructuredRequest<S extends z.ZodType> extends StructuredRequest<S> {
  documents: VisionDocument[];
}

export interface StructuredResult<T> {
  data: T;
  usage: Usage;
}

let cached: { key: string; client: Anthropic } | null = null;

function client(): Anthropic {
  const key = getServerSecret("ANTHROPIC_API_KEY");
  if (!key) throw new AiNotConfiguredError("ANTHROPIC_API_KEY is not set");
  if (cached?.key !== key) cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 1 }) };
  return cached.client;
}

function documentBlocks(documents: VisionDocument[]): Anthropic.ContentBlockParam[] {
  return documents.map((d) =>
    d.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: d.mediaType, data: d.data } }
      : { type: "image", source: { type: "base64", media_type: d.mediaType, data: d.data } },
  );
}

/**
 * One structured (JSON-schema) call to a Claude model, optionally with
 * page images/PDF attached (D-54 OCR). Current models (e.g. Opus 5.5) run
 * adaptive thinking by default and reject sampling parameters, so only
 * `effort` is configurable (route params). Streaming is used so that long
 * answers never hit HTTP timeouts; the SDK assembles and parses the final
 * message.
 */
async function runStructured<S extends z.ZodType>(
  anthropic: Pick<Anthropic, "messages">,
  model: string,
  system: string,
  content: string | Anthropic.ContentBlockParam[],
  schema: S,
  params: RouteParams,
): Promise<StructuredResult<z.infer<S>>> {
  try {
    const response = await anthropic.messages
      .stream(
        {
          model,
          max_tokens: params.max_tokens ?? 32000,
          system,
          messages: [{ role: "user", content }],
          output_config: {
            format: zodOutputFormat(schema),
            ...(params.effort ? { effort: params.effort } : {}),
          },
        },
        { timeout: params.timeout_ms ?? 120_000 },
      )
      .finalMessage();
    const usage: Usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    if (response.stop_reason === "refusal") {
      throw new ProviderError("model refused the request", "anthropic", 200, false);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ProviderError("output truncated (max_tokens)", "anthropic", 200, true);
    }
    if (response.parsed_output == null) {
      throw new ProviderError("structured output did not match the schema", "anthropic", 200, true);
    }
    return { data: response.parsed_output as z.infer<S>, usage };
  } catch (e) {
    if (e instanceof ProviderError || e instanceof AiNotConfiguredError) throw e;
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new ProviderError(`anthropic auth error ${e.status}`, "anthropic", e.status ?? null, false);
    }
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) {
      throw new ProviderError(`anthropic request error ${e.status}`, "anthropic", e.status ?? null, false);
    }
    if (e instanceof Anthropic.APIError) {
      throw new ProviderError(`anthropic error ${e.status ?? "network"}`, "anthropic", e.status ?? null, true);
    }
    throw new ProviderError(`anthropic call failed: ${(e as Error).message}`, "anthropic", null, true);
  }
}

/** Text-only structured (JSON-schema) output from a Claude model. */
export async function anthropicStructured<S extends z.ZodType>(
  req: StructuredRequest<S>,
  anthropic: Pick<Anthropic, "messages"> = client(),
): Promise<StructuredResult<z.infer<S>>> {
  return runStructured(anthropic, req.model, req.system, req.prompt, req.schema, req.params);
}

/**
 * Structured output with page images/PDF attached (D-54 OCR: `ocr_page`
 * role). Documents come first in the content, per Anthropic's guidance for
 * the best recognition quality; the instruction/prompt follows.
 */
export async function anthropicVisionStructured<S extends z.ZodType>(
  req: VisionStructuredRequest<S>,
  anthropic: Pick<Anthropic, "messages"> = client(),
): Promise<StructuredResult<z.infer<S>>> {
  const content: Anthropic.ContentBlockParam[] = [...documentBlocks(req.documents), { type: "text", text: req.prompt }];
  return runStructured(anthropic, req.model, req.system, content, req.schema, req.params);
}
