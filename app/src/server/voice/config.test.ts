import { beforeEach, describe, expect, it, vi } from "vitest";
const upsert = vi.hoisted(() => vi.fn());
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: (table: string) => ({ upsert: (rows: unknown, options: unknown) => upsert(table, rows, options) }) }) }));
import { ensureLessonVoiceConfig } from "./config";
beforeEach(() => { upsert.mockReset().mockResolvedValue({ error: null }); });
describe("lesson voice configuration without schema migration", () => {
  it("adds missing routes/prices while preserving all existing parent overrides", async () => {
    await ensureLessonVoiceConfig("family");
    expect(upsert).toHaveBeenCalledWith("model_prices", expect.objectContaining({ model: "whisper-1", input_usd_per_mtok: 100 }), { onConflict: "provider,model", ignoreDuplicates: true });
    expect(upsert).toHaveBeenCalledWith("model_routes", [expect.objectContaining({ family_id: "family", role: "voice_transcription", primary_model: "whisper-1" }), expect.objectContaining({ family_id: "family", role: "voice_reply" })], { onConflict: "family_id,role", ignoreDuplicates: true });
  });
  it("fails closed if it cannot record prices", async () => {
    upsert.mockResolvedValueOnce({ error: { message: "not permitted" } });
    await expect(ensureLessonVoiceConfig("family")).rejects.toThrow("voice_unavailable");
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it("reports route configuration failures without exposing database details", async () => {
    upsert.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "internal DB detail" } });
    await expect(ensureLessonVoiceConfig("family")).rejects.toThrow("voice_unavailable");
  });
});
