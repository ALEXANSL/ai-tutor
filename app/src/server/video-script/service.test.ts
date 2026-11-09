import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ upsert: vi.fn(), route: vi.fn(), price: vi.fn(), ai: vi.fn(), upload: vi.fn(), download: vi.fn(), getBucket: vi.fn(), createBucket: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: (table: string) => ({ upsert: (rows: unknown, options: unknown) => f.upsert(table, rows, options) }), storage: { getBucket: f.getBucket, createBucket: f.createBucket, from: (bucket: string) => ({ upload: (...args: unknown[]) => f.upload(bucket, ...args), download: (...args: unknown[]) => f.download(bucket, ...args) }) } }) }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => ({ select: () => ({ eq: () => ({ maybeSingle: () => f.route(family) }) }) }) }));
vi.mock("@/server/ai/store", () => ({ loadPrice: f.price }));
vi.mock("@/server/ai/router", () => ({ callStructured: f.ai }));
import { ensureVideoScriptConfig, generateVideoScript, saveVideoDraft, readVideoDraft } from "./service";
const source = { title: "Урок", subject: "Історія", hash: "a".repeat(64), blocks: [{ id: "b1", title: "Матеріал", text: "Факти" }] };
const scenes = [1, 2].map(n => ({ title: `Сцена ${n}`, narration: "Озвучення", visualPrompt: "An illustration", sourceBlockIds: ["b1"] }));
beforeEach(() => {
  Object.values(f).forEach(fn => fn.mockReset());
  f.upsert.mockResolvedValue({ error: null });
  f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "gpt-4.1-mini" }, error: null });
  f.price.mockResolvedValue({ input_usd_per_mtok: 0.4 });
  f.ai.mockResolvedValue({ result: { scenes }, model: { provider: "openai", model: "gpt-4.1-mini" } });
  f.getBucket.mockResolvedValue({ data: { public: false } });
  f.upload.mockResolvedValue({ error: null });
});
it("uses an independent OpenAI-only role with source blocks and no personal context", async () => {
  const draft = await generateVideoScript("family", source, { minutes: 5, notes: "Спокійно" });
  expect(draft.provider).toBe("openai");
  expect(f.ai).toHaveBeenCalledWith("lesson_video_script", expect.objectContaining({ prompt: expect.stringContaining('"lessonBlocks"') }), { familyId: "family" });
  expect(f.upsert).toHaveBeenCalledWith("model_routes", expect.objectContaining({ family_id: "family", primary_provider: "openai" }), { onConflict: "family_id,role", ignoreDuplicates: true });
});
it("preserves existing routes but rejects Claude primary/fallback and missing prices before a paid request", async () => {
  for (const route of [{ primary_provider: "anthropic" }, { primary_provider: "openai", fallback_provider: "anthropic" }]) {
    f.route.mockResolvedValue({ data: route });
    await expect(ensureVideoScriptConfig("family")).rejects.toThrow("requires_openai");
  }
  f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "custom" } });
  f.price.mockResolvedValue(null);
  await expect(ensureVideoScriptConfig("family")).rejects.toThrow("price_missing");
  expect(f.ai).not.toHaveBeenCalled();
});
it("rejects invented references and malformed scenes", async () => {
  f.ai.mockResolvedValueOnce({ result: { scenes: scenes.map(scene => ({ ...scene, sourceBlockIds: ["invented"] })) }, model: { provider: "openai" } });
  await expect(generateVideoScript("family", source, { minutes: 5, notes: "" })).rejects.toThrow("invalid_source_reference");
  f.ai.mockResolvedValueOnce({ result: { scenes: [] }, model: { provider: "openai" } });
  await expect(generateVideoScript("family", source, { minutes: 5, notes: "" })).rejects.toThrow();
});
it("stores drafts in a verified private bucket with family/subject/topic path and never signs a URL", async () => {
  const draft = await generateVideoScript("family", source, { minutes: 5, notes: "" });
  expect(await saveVideoDraft("family", "subject", "topic", draft)).toBe(true);
  expect(f.upload).toHaveBeenCalledWith("lesson_video_scripts", "family/video-scripts/subject/topic.json", expect.any(String), { contentType: "application/json", upsert: true });
  f.getBucket.mockResolvedValue({ data: { public: true } });
  f.upload.mockClear();
  expect(await saveVideoDraft("family", "subject", "topic", draft)).toBe(false);
  expect(f.upload).not.toHaveBeenCalled();
  f.download.mockResolvedValue({ data: new Blob([JSON.stringify(draft)]), error: null });
  expect(await readVideoDraft("family", "subject", "topic")).toEqual(draft);
});
it("creates a JSON-only private bucket lazily and handles a concurrent creator", async () => {
  const draft = await generateVideoScript("family", source, { minutes: 5, notes: "" });
  f.getBucket.mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: { public: false } });
  f.createBucket.mockResolvedValue({ error: { message: "already exists" } });
  expect(await saveVideoDraft("family", "subject", "topic", draft)).toBe(true);
  expect(f.createBucket).toHaveBeenCalledWith("lesson_video_scripts", { public: false, fileSizeLimit: 150_000, allowedMimeTypes: ["application/json"] });
});
