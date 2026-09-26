import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Demo-blocking bug: `startLessonAction` (and, more cheaply,
 * `chooseStartBlockAction`) runs the lesson-generation pipeline (planning +
 * generation on Claude, then review, possibly rework) synchronously.
 * Without a generous `maxDuration`, the platform's default Server Function
 * timeout cuts the request off and the child's "Почати" button just hangs
 * with no error.
 *
 * A "use server" file (`actions/lesson.ts`) may only export async functions
 * — this Next.js version rejects a `maxDuration` export there at build time
 * (`check:bundle` catches this: "Only async functions are allowed to be
 * exported in a 'use server' file") — so the fix instead lives as a
 * `maxDuration` route-segment export on every page that can trigger these
 * actions. This locks all three down, matching the 300s already used by the
 * books indexing routes (`parent/books/*`, `api/jobs/tick`).
 */
const PAGES = [
  "../(child)/subject/[id]/page.tsx",
  "../(child)/lesson/[sessionId]/page.tsx",
  "../parent/subjects/[id]/page.tsx",
] as const;

describe("maxDuration on every page that can trigger the lesson pipeline", () => {
  for (const rel of PAGES) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    const src = readFileSync(file, "utf8");

    it(`${rel} declares a literal maxDuration export of at least 120s`, () => {
      const match = src.match(/export const maxDuration\s*=\s*(\d+);/);
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeGreaterThanOrEqual(120);
    });
  }

  it("actions/lesson.ts ('use server') does NOT export maxDuration itself (this Next.js version rejects it there)", () => {
    const file = fileURLToPath(new URL("./lesson.ts", import.meta.url));
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/export const maxDuration/);
  });
});
