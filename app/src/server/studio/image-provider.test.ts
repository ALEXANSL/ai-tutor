import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { generateLessonImage, imageProviders, IMAGE_RESERVE_USD, lessonIllustrationPrompt } from "./image-provider";
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); vi.stubEnv("OPENAI_API_KEY", "test-image-key"); vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-gemini-key"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("sends one bounded image request with server-side credentials to OpenAI and records real usage", async () => {
 fetchMock.mockResolvedValue(Response.json({ data:[{b64_json:Buffer.from("image").toString("base64")}], usage:{input_tokens:100,output_tokens:1056} }));
 const result=await generateLessonImage("openai","Minerals, no text");
 const [url,request]=fetchMock.mock.calls[0]!; expect(url).toBe("https://api.openai.com/v1/images/generations"); expect(JSON.parse(request.body)).toMatchObject({model:"gpt-image-1",n:1,quality:"medium",size:"1024x1024"}); expect(request.headers.authorization).toBe("Bearer test-image-key"); expect(result.costUsd).toBeCloseTo(0.04274); expect(result.estimated).toBe(false);
});
it("uses native Gemini IMAGE output and modality-aware pricing without paid search tools", async () => {
 fetchMock.mockResolvedValue(Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:"image/png",data:Buffer.from("image").toString("base64")}}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:1120,thoughtsTokenCount:20,candidatesTokensDetails:[{modality:"IMAGE",tokenCount:1120}]}}));
 const result=await generateLessonImage("gemini","History scene"); const [url,request]=fetchMock.mock.calls[0]!; expect(url).toContain("gemini-3.1-flash-image-preview:generateContent"); expect(url).not.toContain("test-gemini-key"); expect(request.headers["x-goog-api-key"]).toBe("test-gemini-key"); const body=JSON.parse(request.body); expect(body.generationConfig).toMatchObject({candidateCount:1,maxOutputTokens:4096,responseModalities:["IMAGE"]}); expect(body.tools).toBeUndefined(); expect(result.costUsd).toBeCloseTo(0.0339);
});
it("does not retry or silently switch providers on timeout, access denial or refused images", async () => {
 fetchMock.mockResolvedValueOnce(new Response("private error",{status:403})); await expect(generateLessonImage("openai","p")).rejects.toMatchObject({uncertain:false,costUsd:0}); expect(fetchMock).toHaveBeenCalledTimes(1);
 fetchMock.mockRejectedValueOnce(new Error("timeout")); await expect(generateLessonImage("openai","p")).rejects.toMatchObject({uncertain:true,costUsd:IMAGE_RESERVE_USD}); expect(fetchMock).toHaveBeenCalledTimes(2);
 fetchMock.mockResolvedValueOnce(Response.json({candidates:[{finishReason:"SAFETY"}]})); await expect(generateLessonImage("gemini","p")).rejects.toMatchObject({uncertain:true});
});
it("uses a visible conservative estimate when usage is absent and exposes only key availability", async () => {
 fetchMock.mockResolvedValue(Response.json({data:[{b64_json:Buffer.from("image").toString("base64")}]})); expect(await generateLessonImage("openai","p")).toMatchObject({estimated:true,costUsd:0.15}); expect(JSON.stringify(imageProviders())).not.toContain("test-image-key");
});
it("constructs a factual age-adapted block prompt with no lettering and marks reconstruction limits", () => {
 const prompt=lessonIllustrationPrompt({subject:"Історія",title:"Єгипет",blockTitle:"Піраміди",text:"Будівництво пірамід",age:12},"Покажи будівництво"); expect(prompt).toContain("aged 12"); expect(prompt).toContain("Будівництво пірамід"); expect(prompt).toContain("NO text"); expect(prompt).toContain("artistic reconstructions");
});

it("rejects an oversized Unicode prompt before sending a paid request", async () => {
 await expect(generateLessonImage("gemini", "я".repeat(9000))).rejects.toMatchObject({uncertain:false}); expect(fetchMock).not.toHaveBeenCalled();
});
