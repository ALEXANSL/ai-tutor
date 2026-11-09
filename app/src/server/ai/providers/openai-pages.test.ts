import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { openaiStructured } from "./openai";
afterEach(() => vi.unstubAllEnvs());
it("sends only provided page documents in one Responses API call while keeping JSON output validation", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fake-test-key");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({ answerUk: "Пояснення за сторінкою" }), usage: { input_tokens: 20, output_tokens: 10 } })));
  const result = await openaiStructured({ model: "gpt-5.4", system: "Rules", prompt: "Question", params: { effort: "low" }, documents: [{ mediaType: "application/pdf", data: "SELECTED_PAGE_ONLY" }], schema: z.object({ answerUk: z.string() }) }, fetcher);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/responses");
  const body = JSON.parse(init.body);
  expect(body.input[0].content).toEqual([{ type: "input_text", text: "Question" }, { type: "input_file", filename: "textbook-page-1.pdf", file_data: "data:application/pdf;base64,SELECTED_PAGE_ONLY" }]);
  expect(body.text.format.strict).toBe(true); expect(body.reasoning.effort).toBe("low");
  expect(result.data.answerUk).toContain("Пояснення"); expect(fetcher).toHaveBeenCalledOnce();
});
