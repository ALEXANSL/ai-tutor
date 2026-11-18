import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { openaiStructured, openaiStructuredCaptured } from "./openai";
const req = { model: "test", system: "Rules", prompt: "Source", schema: z.object({ title: z.string() }), params: {} };
const usage = { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 400 } };
const fetcher = (over: object = {}) => vi.fn(async () => Response.json({ status: "completed", output_text: '{"title":"Lesson"}', usage, ...over }));
beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "test-key"));
afterEach(() => vi.unstubAllEnvs());
it("captures completed validated content and separates cached tokens from uncached input", async () => {
 const result = await openaiStructuredCaptured(req, fetcher()); expect(result).toEqual({ data: { result: { title: "Lesson" } }, usage: { inputTokens: 600, outputTokens: 200, cachedInputTokens: 400 } });
});
it.each([
 [{ status: "incomplete", output_text: '{"title":' }, "STUDIO-AI-INCOMPLETE"],
 [{ output_text: '{"title":4}' }, "STUDIO-AI-OUTPUT-SCHEMA"],
 [{ output_text: 'bad JSON' }, "STUDIO-AI-JSON"],
 [{ output_text: '', output: [{ content: [{ type: "refusal" }] }] }, "STUDIO-AI-REFUSAL"],
 [{ output_text: '' }, "STUDIO-AI-NO-OUTPUT"],
 [{ status: "failed" }, "STUDIO-AI-RESPONSE-STATE"],
 [{ status: undefined }, "STUDIO-AI-RESPONSE-STATE"],
])("retains known paid usage when output cannot be applied (%s)", async (body, code) => {
 const result = await openaiStructuredCaptured(req, fetcher(body)); expect(result.data.failure?.code).toBe(code); expect(result.usage.outputTokens).toBe(200);
 if (code === "STUDIO-AI-OUTPUT-SCHEMA") expect(result.data.failure?.paths).toEqual(["title"]);
});
it("does not manufacture zero costs when usage is missing or invalid", async () => {
 for (const invalid of [null, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 4 } }]) await expect(openaiStructuredCaptured(req, fetcher({ usage: invalid }))).rejects.toMatchObject({ code: "unknown_usage" });
});
it("classifies timeout and schema rejection without reflecting provider error contents", async () => {
 await expect(openaiStructuredCaptured(req, vi.fn(async () => { throw new DOMException("private", "TimeoutError"); }))).rejects.toMatchObject({ code: "timeout", status: null });
 const rejected = vi.fn(async () => Response.json({ error: { code: "invalid_json_schema", message: "PRIVATE_SECRET" } }, { status: 400 }));
 const error = await openaiStructuredCaptured(req, rejected).catch(error => error); expect(error).toMatchObject({ code: "invalid_schema", status: 400 }); expect(error.message).not.toContain("PRIVATE_SECRET");
});
it("keeps the regular adapter rejecting invalid content for other consumers", async () => {
 await expect(openaiStructured(req, fetcher({ status: "incomplete" }))).rejects.toMatchObject({ name: "ProviderError" });
 await expect(openaiStructured(req, fetcher({ output_text: '{"title":4}' }))).rejects.toMatchObject({ name: "ProviderError" });
});
