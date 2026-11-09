import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
const f = vi.hoisted(() => ({ upsert: vi.fn(), route: vi.fn(), structured: vi.fn(), vision: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: (table: string) => ({ upsert: (rows: unknown, options: unknown) => f.upsert(table, rows, options) }) }) }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => ({ select: () => ({ eq: (field: string, value: string) => ({ maybeSingle: () => f.route(familyId, field, value) }) }) }) }));
vi.mock("@/server/ai/router", () => ({ callStructured: f.structured, callVisionStructured: f.vision }));
import { callLessonTutor, ensureLessonTutorConfig } from "./tutorModel";
beforeEach(() => { Object.values(f).forEach(fn => fn.mockReset()); f.upsert.mockResolvedValue({ error: null }); f.route.mockResolvedValue({ data: { primary_provider: "openai", primary_model: "gpt-5.4" } }); f.structured.mockResolvedValue({ result: { answerUk: "Відповідь" } }); f.vision.mockResolvedValue({ result: { answerUk: "Відповідь за сторінкою" } }); });
const request = { system: "Rules", prompt: "Question", schema: z.object({ answerUk: z.string() }) };
it("adds an explicit GPT-5.4 lesson route and price without replacing legacy routes or existing overrides", async () => {
  await callLessonTutor(request, { familyId: "family" });
  expect(f.upsert).toHaveBeenCalledWith("model_routes", expect.objectContaining({ family_id: "family", role: "lesson_tutor", primary_provider: "openai", primary_model: "gpt-5.4" }), { onConflict: "family_id,role", ignoreDuplicates: true });
  expect(f.structured).toHaveBeenCalledWith("lesson_tutor", request, { familyId: "family" });
  expect(f.route).toHaveBeenCalledWith("family", "role", "lesson_tutor");
});
it("passes PDF pages through the same budgeted role using the vision adapter", async () => {
  const documents = [{ mediaType: "application/pdf" as const, data: "PDF" }];
  await callLessonTutor({ ...request, documents }, { familyId: "family" });
  expect(f.vision).toHaveBeenCalledWith("lesson_tutor", { ...request, documents }, { familyId: "family" });
  expect(f.structured).not.toHaveBeenCalled();
});
it("fails before a paid call if any active route points to another provider or configuration write fails", async () => {
  f.route.mockResolvedValue({ data: { primary_provider: "openai", economy_provider: "anthropic" } });
  await expect(ensureLessonTutorConfig("family")).rejects.toThrow("requires_openai");
  f.upsert.mockResolvedValueOnce({ error: { message: "SECRET DB DETAIL" } });
  await expect(ensureLessonTutorConfig("family")).rejects.toThrow("price_setup");
  expect(f.structured).not.toHaveBeenCalled(); expect(f.vision).not.toHaveBeenCalled();
});
