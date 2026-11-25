import { beforeEach, expect, it, vi } from "vitest";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222", batch = "33333333-3333-4333-8333-333333333333";
const f = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), start: vi.fn(), kick: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.auth }));
vi.mock("@/server/voice/service", () => ({ voiceActor: async () => ({ child: { id: "child" } }) }));
vi.mock("@/server/eschool/store", () => ({ readSchoolDoc: f.read, SCHOOL_ENTRY: "eschool.entry" }));
vi.mock("@/server/studio/workflow", () => ({ startStudio: f.start }));
vi.mock("@/server/studio/wake", () => ({ kickStudio: f.kick }));
vi.mock("next/cache", () => ({ revalidatePath: f.revalidate }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => { const q = { eq: () => q, limit: () => q, maybeSingle: async () => ({ data: { grade: 6 } }) }; return q; } }) }));
import { queueSchoolBatchAction } from "./school-batch";

const source = (kind: "lesson" | "homework") => ({ kind, subject: "Математика", subjectExternalId: 1, lessonDate: "2026-11-26", dueDate: kind === "homework" ? "2026-11-27" : null, topic: "Дроби", text: kind === "homework" ? "№ 245" : "", attachments: 0, cancelled: false, schedule: null });
beforeEach(() => {
  vi.clearAllMocks(); f.auth.mockResolvedValue({ familyId: "fam" });
  f.read.mockImplementation(async (_f: string, _c: string, id: string) => id === a ? { subjectId: "55555555-5555-4555-8555-555555555555", source: source("lesson") } : id === b ? { subjectId: null, source: source("homework") } : null);
  f.start.mockImplementation(async (_f: string, request: { title: string }, requestId: string) => `p-${requestId.slice(0, 4)}-${request.title.slice(0, 2)}`);
});

it("queues each picked entry as its own Studio project with the parent's per-item limit", async () => {
  const result = await queueSchoolBatchAction({ batchId: batch, budgetUsd: 2, items: [{ entryId: a, narratedDeck: true }, { entryId: b, narratedDeck: false }] });
  expect(result.status).toBe("ok"); expect(f.start).toHaveBeenCalledTimes(2); expect(f.kick).toHaveBeenCalledTimes(2);
  const [lesson, homework] = f.start.mock.calls.map(c => c[1]);
  expect(lesson).toMatchObject({ subjectId: "55555555-5555-4555-8555-555555555555", budgetUsd: 2, narratedDeck: true, lessonCount: 1, mode: "course" });
  expect(homework).toMatchObject({ subjectId: null, narratedDeck: false }); expect(homework.idea).toContain("Готових відповідей до самого завдання не давай"); expect(homework.idea).toContain("№ 245");
  expect(f.read).toHaveBeenCalledWith("fam", "child", a, "eschool.entry");
});

it("reuses the same request ids when the same batch is sent twice", async () => {
  const input = { batchId: batch, budgetUsd: 3, items: [{ entryId: a, narratedDeck: true }] };
  await queueSchoolBatchAction(input); await queueSchoolBatchAction(input);
  expect(f.start.mock.calls[0]![2]).toBe(f.start.mock.calls[1]![2]);
});

it("reports a missing entry without stopping the rest", async () => {
  const result = await queueSchoolBatchAction({ batchId: batch, budgetUsd: 3, items: [{ entryId: "44444444-4444-4444-8444-444444444444", narratedDeck: true }, { entryId: a, narratedDeck: true }] });
  expect(result.status === "ok" && result.results.map(r => r.status)).toEqual(["error", "ok"]);
});

it("rejects an over-long batch or a too-small limit before spending anything", async () => {
  expect((await queueSchoolBatchAction({ batchId: batch, budgetUsd: 0.1, items: [{ entryId: a, narratedDeck: true }] })).status).toBe("error");
  expect((await queueSchoolBatchAction({ batchId: batch, budgetUsd: 3, items: Array.from({ length: 21 }, () => ({ entryId: a, narratedDeck: true })) })).status).toBe("error");
  expect(f.start).not.toHaveBeenCalled();
});

it("requires parent access", async () => {
  f.auth.mockRejectedValue(new Error("parent only"));
  await expect(queueSchoolBatchAction({})).rejects.toThrow("parent only"); expect(f.read).not.toHaveBeenCalled();
});
