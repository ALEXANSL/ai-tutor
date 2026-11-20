import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({
  storage: { getBucket: async () => ({ data: { public: false } }), from: () => ({ list: mocks.list }) },
}) }));
import { audioExists } from "./storage";
const family = "aaaaaaaa-1111-4444-8888-000000000000", id = "bbbbbbbb-1111-4444-8888-000000000000", key = "c".repeat(64);
beforeEach(() => vi.clearAllMocks());
it("accepts an empty private folder for the first recording and detects an existing exact recording", async () => {
  mocks.list.mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: [{ name: key + ".mp3" }], error: null });
  expect(await audioExists(family, id, key)).toBe(false);
  expect(await audioExists(family, id, key)).toBe(true);
  expect(mocks.list).toHaveBeenCalledWith(family + "/" + id, { search: key + ".mp3", limit: 1 });
});
it("keeps storage failures distinct from a missing recording", async () => {
  mocks.list.mockResolvedValueOnce({ data: null, error: new Error("offline") });
  await expect(audioExists(family, id, key)).rejects.toThrow("перевірити");
});
