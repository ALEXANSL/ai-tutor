import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioPendingModelCall } from "@/lib/studio";
interface Row { id: string; family_id: string; type: string; status: string; payload: Record<string, unknown> }
const f = vi.hoisted(() => ({ rows: [] as Row[], writes: [] as { row: Row; options: { ignoreDuplicates?: boolean } }[], readError: false, writeError: false, errorAfterWrite: false }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => ({
  select: () => {
    const filters: [string, unknown][] = [];
    const chain = { eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
      maybeSingle: async () => ({ error: f.readError ? { message: "unavailable" } : null, data: f.readError ? null : structuredClone(f.rows.find(row => row.family_id === familyId && filters.every(([key, value]) => row[key as keyof Row] === value)) ?? null) }) };
    return chain;
  },
  client: { from: () => ({ upsert: async (row: Row, options: { ignoreDuplicates?: boolean }) => {
    f.writes.push({ row: structuredClone(row), options });
    if (f.writeError) return { error: { message: "unavailable" } };
    const previous = f.rows.find(item => item.id === row.id);
    if (!previous) f.rows.push(structuredClone(row));
    else if (!options.ignoreDuplicates) Object.assign(previous, structuredClone(row));
    return { error: f.errorAfterWrite ? { message: "response lost" } : null };
  } }) },
}) }));
import { readStudioPaidResult, writeStudioPaidResult, type StudioPaidModelResult } from "./paid-result";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const pending = (over: Partial<StudioPendingModelCall> = {}): StudioPendingModelCall => ({ id: "33333333-3333-4333-8333-333333333333", phase: "analyze", cursor: 0, inputHash: "source-input-hash", reservedUsd: 1, billed: false, ...over });
const result = (): StudioPaidModelResult => ({ result: { title: "Аналіз", topics: ["Енергія", "Рух"], quotes: [] }, model: { provider: "openai", model: "gpt-5.4" }, costUsd: 0.137 });
beforeEach(() => { f.rows = []; f.writes = []; f.readError = false; f.writeError = false; f.errorAfterWrite = false; });

describe("immutable paid model receipts", () => {
  it("returns null only for a missing family-scoped receipt", async () => {
    expect(await readStudioPaidResult("family-a", PROJECT, pending())).toBeNull();
    await writeStudioPaidResult("family-a", PROJECT, pending(), result());
    expect(await readStudioPaidResult("family-b", PROJECT, pending())).toBeNull();
  });
  it("writes a complete receipt and rereads it after JSONB property reordering", async () => {
    await writeStudioPaidResult("family-a", PROJECT, pending(), result());
    expect(f.writes[0]!.options.ignoreDuplicates).toBe(true);
    expect(f.rows[0]).toMatchObject({ id: pending().id, family_id: "family-a", type: "studio.model_result", status: "done" });
    const row = f.rows[0]!;
    row.payload = Object.fromEntries(Object.entries(row.payload).reverse());
    const body = row.payload.result as Record<string, unknown>;
    row.payload.result = Object.fromEntries(Object.entries(body).reverse());
    expect(await readStudioPaidResult("family-a", PROJECT, pending())).toEqual(result());
  });
  it("repeats an identical write without overwriting it and tolerates changed billing bookkeeping", async () => {
    await writeStudioPaidResult("family-a", PROJECT, pending(), result());
    const original = structuredClone(f.rows[0]);
    await writeStudioPaidResult("family-a", PROJECT, pending({ billed: true }), result());
    expect(f.rows).toHaveLength(1); expect(f.rows[0]).toEqual(original);
    expect(await readStudioPaidResult("family-a", PROJECT, pending({ billed: true }))).toEqual(result());
  });
  it("refuses to overwrite an earlier response for the same call ID", async () => {
    await writeStudioPaidResult("family-a", PROJECT, pending(), result());
    await expect(writeStudioPaidResult("family-a", PROJECT, pending(), { ...result(), result: { title: "Інша відповідь" } })).rejects.toThrow("STUDIO-RESULT");
    expect(await readStudioPaidResult("family-a", PROJECT, pending())).toEqual(result());
  });
  it("refuses another project, input fingerprint, phase or cursor without treating it as missing", async () => {
    await writeStudioPaidResult("family-a", PROJECT, pending(), result());
    await expect(readStudioPaidResult("family-a", OTHER_PROJECT, pending())).rejects.toThrow("STUDIO-RESULT");
    for (const changed of [pending({ inputHash: "different" }), pending({ phase: "plan" }), pending({ cursor: 1 })]) {
      await expect(readStudioPaidResult("family-a", PROJECT, changed)).rejects.toThrow("STUDIO-RESULT");
    }
  });
  it("does not overwrite another family's existing row even if a call ID is reused", async () => {
    await writeStudioPaidResult("family-a", PROJECT, pending(), result());
    await expect(writeStudioPaidResult("family-b", PROJECT, pending(), result())).rejects.toThrow("STUDIO-RESULT");
    expect(f.rows).toHaveLength(1); expect(f.rows[0]!.family_id).toBe("family-a");
  });
  it.each(["type", "status", "familyId", "callId", "digest", "costUsd", "result"])("detects changed receipt %s", async (field) => {
    await writeStudioPaidResult("family-a", PROJECT, pending(), result());
    const row = f.rows[0]!;
    if (field === "type" || field === "status") row[field] = "wrong";
    else row.payload[field] = field === "costUsd" ? 0.25 : "tampered";
    await expect(readStudioPaidResult("family-a", PROJECT, pending())).rejects.toThrow("STUDIO-RESULT");
  });
  it("preserves null and primitive JSON results for later validation, rather than pretending they were absent", async () => {
    await writeStudioPaidResult("family-a", PROJECT, pending(), { ...result(), result: null, costUsd: 0 });
    expect(await readStudioPaidResult("family-a", PROJECT, pending())).toMatchObject({ result: null, costUsd: 0 });
  });
  it.each([-1, NaN, Infinity])("rejects invalid actual cost %s before persisting", async (costUsd) => {
    await expect(writeStudioPaidResult("family-a", PROJECT, pending(), { ...result(), costUsd })).rejects.toThrow("STUDIO-RESULT");
    expect(f.writes).toHaveLength(0);
  });
  it.each([undefined, { value: undefined }, { value: Infinity }, { value: 1n }])("rejects a result that cannot be preserved as faithful JSON (case %#)", async (value) => {
    await expect(writeStudioPaidResult("family-a", PROJECT, pending(), { ...result(), result: value })).rejects.toThrow("STUDIO-RESULT");
    expect(f.writes).toHaveLength(0);
  });
  it("bounds raw UTF8 result size without clipping it", async () => {
    await expect(writeStudioPaidResult("family-a", PROJECT, pending(), { ...result(), result: { text: "а".repeat(250000) } })).rejects.toThrow("STUDIO-RESULT-SIZE");
    expect(f.writes).toHaveLength(0);
    const fitting = { ...result(), result: { text: "а".repeat(249000) } };
    await writeStudioPaidResult("family-a", PROJECT, pending(), fitting);
    expect(await readStudioPaidResult("family-a", PROJECT, pending())).toEqual(fitting);
  });
  it("keeps an ambiguous successful write recoverable without inventing another response", async () => {
    f.errorAfterWrite = true;
    await expect(writeStudioPaidResult("family-a", PROJECT, pending(), result())).rejects.toThrow("STUDIO-RESULT-STORE");
    expect(await readStudioPaidResult("family-a", PROJECT, pending())).toEqual(result());
  });
  it("distinguishes failed reads/writes from a missing receipt", async () => {
    f.writeError = true;
    await expect(writeStudioPaidResult("family-a", PROJECT, pending(), result())).rejects.toThrow("STUDIO-RESULT-STORE");
    f.readError = true;
    await expect(readStudioPaidResult("family-a", PROJECT, pending())).rejects.toThrow("STUDIO-RESULT-STORE");
  });
  it("validates pending-call metadata and never mutates money or workflow state", async () => {
    for (const call of [pending({ id: "bad" }), pending({ inputHash: "" }), pending({ cursor: -1 }), pending({ reservedUsd: Infinity })]) {
      await expect(writeStudioPaidResult("family-a", PROJECT, call, result())).rejects.toThrow("STUDIO-RESULT");
    }
    const call = pending(), before = structuredClone(call);
    await writeStudioPaidResult("family-a", PROJECT, call, result());
    expect(call).toEqual(before);
  });
});
