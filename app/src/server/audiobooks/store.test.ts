import { beforeEach, expect, it, vi } from "vitest";
import { familyId, audioId, materialId, partFixture } from "./__fixtures__/part";
const f = vi.hoisted(() => ({ calls: [] as unknown[][], rows: [] as unknown[], error: null as unknown, inserted: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  f.calls.push(["family", family]);
  const builder = { eq: (...a: unknown[]) => { f.calls.push(["eq", ...a]); return builder; }, neq: (...a: unknown[]) => { f.calls.push(["neq", ...a]); return builder; }, order: () => builder, range: async () => ({ data: f.rows, error: f.error }), select: () => builder, maybeSingle: async () => ({ data: f.rows[0] ?? null, error: f.error }) };
  return { select: (...a: unknown[]) => { f.calls.push(["select", ...a]); return builder; }, update: (...a: unknown[]) => { f.calls.push(["update", ...a]); return builder; }, insert: f.inserted };
} }));
import { readAudioPart, saveAudioPart, listAudioCards } from "./store";
beforeEach(() => { f.calls = []; f.rows = []; f.error = null; });
it("scopes project reads and compare-and-swap writes by family/type/revision", async () => {
  f.rows = [{ payload: partFixture() }]; expect(await readAudioPart(familyId, audioId)).toEqual(partFixture()); expect(f.calls).toContainEqual(["eq", "type", "audiobook.part"]); expect(f.calls).toContainEqual(["family", familyId]);
  f.rows = [{ id: audioId }]; await saveAudioPart(familyId, audioId, partFixture({ revision: 2 }), { state: "draft" }); expect(f.calls).toContainEqual(["eq", "payload->>revision", "2"]);
  f.rows = []; await expect(saveAudioPart(familyId, audioId, partFixture(), { state: "draft" })).rejects.toThrow("Стан");
});
it("catalog selects metadata only and requires published/ready for child access", async () => {
  f.rows = [{ id: audioId, materialId, title: "Розділ", bookTitle: "Книга", state: "ready", published: "true", ready: "2", total: "2", from: "23", to: "24", createdAt: "now" }];
  const cards = await listAudioCards(familyId, materialId, true); expect(cards[0]).toMatchObject({ materialId, ready: 2, from: 23, published: true }); expect(f.calls).toContainEqual(["eq", "payload->>published", "true"]); expect(f.calls).toContainEqual(["eq", "payload->>state", "ready"]);
  const select = f.calls.find(c => c[0] === "select")![2] as string; expect(select).not.toContain("paragraphs"); expect(select).not.toContain("segments"); expect(select).not.toContain("manuscript");
});
