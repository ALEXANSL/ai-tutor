import "server-only";
import { z } from "zod";
import { getServerSecret } from "@/server/env";
import { AiNotConfiguredError, ProviderError } from "@/server/ai/types";
import type { StructuredRequest } from "@/server/ai/providers/anthropic";
import type { OpenAiCapturedResult } from "@/server/ai/providers/openai";

export function geminiKey() {
  return getServerSecret("GOOGLE_GENERATIVE_AI_API_KEY") ?? getServerSecret("GEMINI_API_KEY") ?? getServerSecret("GOOGLE_API_KEY");
}

export async function geminiStudio(req: StructuredRequest<z.ZodType>) {
  const key = geminiKey();
  if (!key) throw new AiNotConfiguredError("Gemini API key missing");
  const text = typeof req.prompt === "string" ? req.prompt : req.prompt.map(block => block.text).join("\n");
  let response: Response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(req.model) + ":generateContent", {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system + "\nReturn JSON matching this schema:\n" + JSON.stringify(z.toJSONSchema(req.schema)) }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: req.params.max_tokens, candidateCount: 1 },
      }), signal: AbortSignal.timeout(req.params.timeout_ms ?? 120000), redirect: "error",
    });
  } catch (error) {
    throw new ProviderError("Gemini request interrupted", "gemini", null, true, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!response.ok) throw new ProviderError("Gemini request rejected", "gemini", response.status, response.status === 429 || response.status >= 500, "http");
  const body = await response.json();
  const counts = body.usageMetadata;
  const input = counts?.promptTokenCount, output = counts?.candidatesTokenCount ?? 0, thinking = counts?.thoughtsTokenCount ?? 0;
  if (![input, output, thinking].every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(counts?.totalTokenCount) || counts.totalTokenCount !== input + output + thinking)
    throw new ProviderError("Gemini usage unavailable", "gemini", 200, false, "unknown_usage");
  const candidate = body.candidates?.[0];
  const raw = candidate?.content?.parts?.filter((part: { thought?: boolean }) => !part.thought).map((part: {text?: string}) => part.text ?? "").join("") ?? "";
  let data: OpenAiCapturedResult;
  if (candidate?.finishReason !== "STOP") {
    data = { result: raw, failure: { code: candidate?.finishReason === "MAX_TOKENS" ? "STUDIO-AI-INCOMPLETE" : "STUDIO-AI-REFUSAL", paths: [] } };
  } else {
    try {
      const parsed: unknown = JSON.parse(raw);
      const checked = req.schema.safeParse(parsed);
      data = checked.success ? { result: checked.data } : { result: parsed, failure: { code: "STUDIO-AI-OUTPUT-SCHEMA", paths: checked.error.issues.slice(0, 8).map(issue => issue.path.join(".").replace(/[^a-zA-Z0-9_.]/g, "").slice(0, 400) || "result") } };
    } catch { data = { result: raw, failure: { code: "STUDIO-AI-JSON", paths: [] } }; }
  }
  return { data, usage: { inputTokens: input, outputTokens: output + thinking } };
}
