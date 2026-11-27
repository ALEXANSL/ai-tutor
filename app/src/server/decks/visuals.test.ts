import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ list: vi.fn(), upload: vi.fn(), generate: vi.fn(), budget: vi.fn(), record: vi.fn(), photo: vi.fn(), normalise: vi.fn(), map: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage: { from: () => ({ list: f.list, upload: f.upload }) } }) }));
vi.mock("@/server/ai/store", () => ({ getBudgetState: f.budget, recordCall: f.record }));
vi.mock("@/server/studio/illustrations", () => ({ normaliseIllustration: f.normalise }));
vi.mock("./design", () => ({ slidePicture: f.photo }));
vi.mock("./maps", () => ({ renderPlaceMap: f.map, validPlaces: (p: unknown[] | undefined) => p ?? [] }));
vi.mock("@/server/studio/image-provider", async () => {
  class ImageProviderError extends Error { constructor(message: string, readonly uncertain: boolean, readonly costUsd = 0, readonly status?: number) { super(message); } }
  return { ImageProviderError, IMAGE_MODELS: { gemini: "g-img", openai: "o-img" }, IMAGE_RESERVE_USD: 0.15, generateLessonImage: f.generate,
    imageProviders: () => [{ provider: "gemini", available: true }, { provider: "openai", available: true }] };
});
import { deckImageEstimateUsd, deckImagePrompt, prepareSlideVisual } from "./visuals";
import { ImageProviderError } from "@/server/studio/image-provider";

const slide = { heading: "Море", takeaway: "Греки стали мореплавцями", caption: "Кораблі в бухті", photoQuery: "trireme", imagePrompt: "Greek triremes in a rocky bay", narration: "" };
beforeEach(() => {
  vi.resetAllMocks();
  f.list.mockResolvedValue({ data: [], error: null }); f.upload.mockResolvedValue({ error: null }); f.budget.mockResolvedValue("ok");
  f.normalise.mockImplementation(async (b: Uint8Array) => Buffer.from(b));
});

it("asks for a text-free, accurate, child-safe picture of the slide's scene", () => {
  const prompt = deckImagePrompt("Давня Греція", "Greek triremes in a rocky bay");
  expect(prompt).toContain("Давня Греція"); expect(prompt).toContain("Greek triremes");
  expect(prompt).toMatch(/NO text/); expect(prompt).toMatch(/historical/); expect(prompt).toMatch(/classical iconography/); expect(prompt).toMatch(/central/); expect(prompt).toMatch(/suitable for a child/);
});

it("generates, stores and logs the cost of an AI picture", async () => {
  f.generate.mockResolvedValue({ bytes: new Uint8Array([1, 2]), inputTokens: 100, outputTokens: 1000, costUsd: 0.03, estimated: false });
  const visual = await prepareSlideVisual("fam", "deck", "Давня Греція", slide);
  expect(f.generate).toHaveBeenCalledWith("gemini", expect.stringContaining("Greek triremes"));
  expect(visual).toMatchObject({ kind: "ai", path: expect.stringMatching(/^deck-images\/fam\/[0-9a-f]{64}\.jpg$/) });
  expect(f.upload).toHaveBeenCalledWith(visual.path, expect.any(Buffer), expect.objectContaining({ contentType: "image/jpeg" }));
  expect(f.record).toHaveBeenCalledWith("fam", expect.objectContaining({ role: "deck.illustration", status: "ok", cost_usd: 0.03, ref_id: "deck" }));
  expect(f.photo).not.toHaveBeenCalled();
});

it("reuses a cached picture without paying again", async () => {
  f.generate.mockResolvedValue({ bytes: new Uint8Array([1]), inputTokens: 1, outputTokens: 1, costUsd: 0.03, estimated: false });
  const first = await prepareSlideVisual("fam", "deck", "Давня Греція", slide);
  const name = first.path!.split("/").at(-1);
  f.list.mockResolvedValue({ data: [{ name }], error: null });
  const second = await prepareSlideVisual("fam", "deck2", "Давня Греція", slide);
  expect(second.path).toBe(first.path);
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it("falls back to a free-licence photo when the image service fails, without retrying the paid call", async () => {
  f.generate.mockRejectedValue(new ImageProviderError("down", true, 0.15));
  f.photo.mockResolvedValue({ bytes: Buffer.from("photo"), credit: "Trireme · Author · CC BY 4.0 · https://commons.wikimedia.org/wiki/File:T" });
  const visual = await prepareSlideVisual("fam", "deck", "Давня Греція", slide);
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.record).toHaveBeenCalledWith("fam", expect.objectContaining({ status: "error", cost_usd: 0.15 }));
  expect(visual).toMatchObject({ kind: "photo", credit: "Trireme · Author · CC BY 4.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:T" });
});

it("moves to the next configured service when one clearly refuses (wrong model, no access)", async () => {
  f.generate.mockRejectedValueOnce(new ImageProviderError("Модель зображень недоступна", false, 0, 404))
    .mockResolvedValueOnce({ bytes: new Uint8Array([3]), inputTokens: 10, outputTokens: 1000, costUsd: 0.04, estimated: false });
  const visual = await prepareSlideVisual("fam", "deck", "Давня Греція", slide);
  expect(f.generate.mock.calls.map(c => c[0])).toEqual(["gemini", "openai"]);
  expect(f.record).toHaveBeenCalledWith("fam", expect.objectContaining({ provider: "gemini", status: "error", error: expect.stringContaining("HTTP 404") }));
  expect(visual.kind).toBe("ai");
  expect(f.photo).not.toHaveBeenCalled();
});

it("does not call the image service over the family budget and leaves the slide text-only without a photo", async () => {
  f.budget.mockResolvedValue("hard_stop"); f.photo.mockResolvedValue(undefined);
  expect(await prepareSlideVisual("fam", "deck", "Т", slide)).toEqual({ kind: "none" });
  expect(f.generate).not.toHaveBeenCalled();
});

it("estimates the picture cost of a deck", () => {
  expect(deckImageEstimateUsd(10)).toBe(0.4);
});

it("draws a map for a slide about places, without paying for a picture", async () => {
  f.map.mockResolvedValue({ bytes: Buffer.from("map"), labels: [{ name: "Афіни", x: 0.5, y: 0.4 }] });
  const visual = await prepareSlideVisual("fam", "deck", "Т", { ...slide, visualType: "map", places: [{ name: "Афіни", lat: 37.98, lon: 23.73 }] });
  expect(visual).toMatchObject({ kind: "map", labels: [{ name: "Афіни" }], path: expect.stringMatching(/^deck-images\/fam\//) });
  expect(f.generate).not.toHaveBeenCalled(); expect(f.photo).not.toHaveBeenCalled();
});

it("prefers a real photo for a real object and paints only when none is found", async () => {
  f.photo.mockResolvedValueOnce({ bytes: Buffer.from("p"), credit: "Parthenon · A · CC BY 4.0 · https://commons.wikimedia.org/wiki/File:P" });
  expect(await prepareSlideVisual("fam", "deck", "Т", { ...slide, visualType: "photo" })).toMatchObject({ kind: "photo" });
  expect(f.generate).not.toHaveBeenCalled();
  f.photo.mockResolvedValueOnce(undefined);
  f.generate.mockResolvedValue({ bytes: new Uint8Array([1]), inputTokens: 1, outputTokens: 1, costUsd: 0.04, estimated: false });
  expect(await prepareSlideVisual("fam", "deck", "Т", { ...slide, visualType: "photo" })).toMatchObject({ kind: "ai" });
});

it("leaves a slide without a picture when its type is none", async () => {
  expect(await prepareSlideVisual("fam", "deck", "Т", { ...slide, visualType: "none" })).toEqual({ kind: "none" });
  expect(f.generate).not.toHaveBeenCalled(); expect(f.photo).not.toHaveBeenCalled();
});
