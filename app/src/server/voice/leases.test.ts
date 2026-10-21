import { beforeEach, describe, expect, it } from "vitest";
import { forFamily } from "@/server/db/family-scope";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLease, readLease, renewLease, stopLease, claimLease, releaseLease } from "./leases";
let rows: Record<string, unknown>[] = [];
const filters: [string, unknown][] = [];
let conflict: (() => void) | null = null;
const column = (row: Record<string, unknown>, key: string) => key.startsWith("meta->>") ? String((row.meta as Record<string, unknown>)[key.slice(7)]) : row[key];
function query(action: "read" | "update", patch?: Record<string, unknown>) {
  const conditions: [string, unknown][] = [];
  const self = {
    eq: (key: string, value: unknown) => { conditions.push([key, value]); filters.push([key, value]); return self; },
    select: () => self,
    maybeSingle: async () => {
      if (action === "update" && conflict) { const f = conflict; conflict = null; f(); }
      const row = rows.find(row => conditions.every(([key, value]) => column(row, key) === value));
      if (row && action === "update") Object.assign(row, structuredClone(patch));
      return { data: row ? structuredClone(row) : null, error: null };
    },
  };
  return self;
}
const client = { from: () => ({
  select: () => query("read"), update: (patch: Record<string, unknown>) => query("update", patch),
  insert: (row: Record<string, unknown>) => ({ select: () => ({ single: async () => { rows.push({ ...structuredClone(row), id: "lease" }); return { data: { id: "lease" }, error: null }; } }) }),
}) } as unknown as SupabaseClient;
const scope = forFamily("family", client);
const create = () => createLease(scope, "child", "chat", { kind: "chapter", lessonId: "lesson", stepId: "step" });
const meta = () => rows[0]!.meta as Record<string, unknown>;
beforeEach(() => { rows = []; filters.length = 0; conflict = null; });
describe("lesson voice message leases", () => {
  it("creates an authenticated-family/child system marker and expires it after 60 seconds", async () => {
    const lease = await create();
    expect(rows[0]).toMatchObject({ family_id: "family", author: "system", type: "system", chat_id: "chat", meta: { kind: "lesson_voice_session", childId: "child" } });
    expect(Date.parse(lease.expires_at) - Date.now()).toBeGreaterThan(59_000);
    expect(await readLease(scope, "child", "lease")).toMatchObject({ id: "lease", revision: 0 });
    expect(filters).toContainEqual(["family_id", "family"]);
  });
  it("never reads another child or family's lease", async () => {
    await create();
    await expect(readLease(scope, "foreign-child", "lease")).rejects.toThrow("voice_expired");
    await expect(readLease(forFamily("foreign-family", client), "child", "lease")).rejects.toThrow("voice_expired");
  });
  it("rejects a normal transcript masquerading as lease state", async () => {
    await create(); rows[0]!.author = "child";
    await expect(readLease(scope, "child", "lease")).rejects.toThrow("voice_expired");
  });
  it("allows only one in-flight transcription per lease", async () => {
    await create();
    const results = await Promise.allSettled([claimLease(scope, "child", "lease"), claimLease(scope, "child", "lease")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("does not revive a stopped lease when heartbeat loses the revision race", async () => {
    await create();
    conflict = () => { meta().revision = 1; meta().ended_at = new Date().toISOString(); };
    await expect(renewLease(scope, "child", "lease")).rejects.toThrow("voice_expired");
    expect(meta().ended_at).not.toBeNull();
  });
  it("does not let an old release unlock a newer claim", async () => {
    await create(); const claim = await claimLease(scope, "child", "lease");
    meta().claim = "new-claim"; meta().revision = Number(meta().revision) + 1;
    await releaseLease(scope, "child", "lease", claim.claim);
    expect(meta().claim).toBe("new-claim"); expect(meta().busy_until).not.toBeNull();
  });
  it("can renew while a turn runs, release it, and continue the next turn", async () => {
    await create(); const first = await claimLease(scope, "child", "lease");
    await renewLease(scope, "child", "lease"); await releaseLease(scope, "child", "lease", first.claim);
    const next = await claimLease(scope, "child", "lease");
    expect(next.claim).not.toBe(first.claim);
  });
  it("stops idempotently and never accepts a turn or renewal after stop", async () => {
    await create(); await stopLease(scope, "child", "lease"); await stopLease(scope, "child", "lease");
    await expect(claimLease(scope, "child", "lease")).rejects.toThrow("voice_expired");
    await expect(renewLease(scope, "child", "lease")).rejects.toThrow("voice_expired");
  });
  it("rejects expired sessions and malformed metadata", async () => {
    await create(); meta().expires_at = "2020-01-01T00:00:00.000Z";
    await expect(readLease(scope, "child", "lease")).rejects.toThrow("voice_expired");
    meta().expires_at = "invalid";
    await expect(readLease(scope, "child", "lease")).rejects.toThrow("voice_expired");
  });
});
