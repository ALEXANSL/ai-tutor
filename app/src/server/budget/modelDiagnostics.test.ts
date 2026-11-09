import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ family: [] as string[], columns: [] as string[], rows: {} as Record<string, unknown[]>, failed: false }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => { f.family.push(family); return { select: (table: string, columns: string) => { f.columns.push(columns); const chain = { order: () => chain, limit: () => chain, returns: async () => ({ data: f.rows[table] ?? [], error: f.failed ? { message: "private DB error" } : null }) }; return chain; } }; } }));
import { loadModelDiagnostics } from "./modelDiagnostics";
beforeEach(() => { f.family.length = 0; f.columns.length = 0; f.failed = false; f.rows = {}; });
it("reads actual routes and calls within the family without chat contents, secrets or raw provider errors", async () => {
  f.rows.model_routes = [{ role: "lesson_tutor", primary_provider: "openai", primary_model: "gpt-5.4" }];
  expect((await loadModelDiagnostics("family")).routes).toEqual(f.rows.model_routes);
  expect(f.family).toEqual(["family"]);
  expect(f.columns.join(",")).not.toMatch(/content|prompt|api_key|\berror\b/);
});
it("distinguishes unavailable diagnostics from an empty successful result", async () => {
  f.failed = true;
  expect(await loadModelDiagnostics("family")).toEqual({ routes: null, calls: null });
});
