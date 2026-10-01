import { describe, expect, it, vi } from "vitest";

/**
 * PO feedback 2026-10-01: `allow_skip_tests` is a general parent-settings
 * toggle for the quiz/test "Пропустити" button. `@/server/db/family-scope`
 * is mocked — no real Supabase call.
 */

const update = vi.fn(async (_table: string, _values: Record<string, unknown>) => ({ error: null as { message: string } | null }));

vi.mock("../db/family-scope", () => ({
  forFamily: (familyId: string) => ({
    familyId,
    update: (table: string, values: Record<string, unknown>) => update(table, values),
  }),
}));

const { setAllowSkipTests } = await import("./service");

describe("setAllowSkipTests", () => {
  it("writes allow_skip_tests = true to parent_settings", async () => {
    await setAllowSkipTests("fam1", true);
    expect(update).toHaveBeenCalledWith("parent_settings", { allow_skip_tests: true });
  });

  it("writes allow_skip_tests = false to parent_settings", async () => {
    await setAllowSkipTests("fam1", false);
    expect(update).toHaveBeenCalledWith("parent_settings", { allow_skip_tests: false });
  });

  it("throws when the update fails", async () => {
    update.mockResolvedValueOnce({ error: { message: "boom" } } as never);
    await expect(setAllowSkipTests("fam1", true)).rejects.toThrow("allow_skip_tests update failed: boom");
  });
});
