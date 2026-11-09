import { beforeEach, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { ProviderError, BudgetBlockedError } from "@/server/ai/types";
const f = vi.hoisted(() => ({ parent: vi.fn(), source: vi.fn(), generate: vi.fn(), save: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.parent }));
vi.mock("@/server/video-script/source", () => ({ loadVideoLessonSource: f.source, VideoSourceError: class extends Error {} }));
vi.mock("@/server/video-script/service", async () => {
  const { z } = await import("zod");
  return { generateVideoScript: f.generate, saveVideoDraft: f.save, videoOptionsSchema: z.object({ minutes: z.number().int().min(2).max(12), notes: z.string().trim().max(1200) }) };
});
import { generateVideoScriptAction } from "./video-script";
const input = { subjectId: "11111111-1111-4111-8111-111111111111", topicId: "22222222-2222-4222-8222-222222222222", minutes: 5, notes: "" };
beforeEach(() => {
  Object.values(f).forEach(fn => fn.mockReset());
  f.parent.mockResolvedValue({ familyId: "authenticated-family" });
  f.source.mockResolvedValue({ title: "Урок" });
  f.generate.mockResolvedValue({ scenes: [] });
  f.save.mockResolvedValue(true);
});
it("authorizes before resolving source and never accepts a caller-supplied family or lesson text", async () => {
  expect((await generateVideoScriptAction({ ...input, familyId: "attacker" } as typeof input)).status).toBe("ok");
  expect(f.source).toHaveBeenCalledWith("authenticated-family", input.subjectId, input.topicId);
  expect(f.generate).toHaveBeenCalledWith("authenticated-family", { title: "Урок" }, { minutes: 5, notes: "" });
});
it("retains authentication redirects and makes no paid call on invalid input", async () => {
  f.parent.mockImplementation(() => redirect("/today"));
  await expect(generateVideoScriptAction(input)).rejects.toThrow("NEXT_REDIRECT");
  expect(f.source).not.toHaveBeenCalled();
  f.parent.mockResolvedValue({ familyId: "family" });
  expect((await generateVideoScriptAction({ ...input, minutes: 999 })).status).toBe("error");
  expect(f.generate).not.toHaveBeenCalled();
});
it("returns paid content even if draft storage fails", async () => {
  f.save.mockRejectedValue(new Error("private storage error"));
  expect(await generateVideoScriptAction(input)).toEqual({ status: "ok", draft: { scenes: [] }, saved: false });
});
it("shows safe provider/budget errors and never saves a failed generation", async () => {
  f.generate.mockRejectedValueOnce(new ProviderError("SECRET payload", "openai", 401, false));
  const error = await generateVideoScriptAction(input);
  expect(JSON.stringify(error)).toContain("401");
  expect(JSON.stringify(error)).not.toContain("SECRET");
  f.generate.mockRejectedValueOnce(new BudgetBlockedError("hard_stop", "lesson_video_script"));
  expect(JSON.stringify(await generateVideoScriptAction(input))).toContain("ліміт витрат");
  expect(f.save).not.toHaveBeenCalled();
});
