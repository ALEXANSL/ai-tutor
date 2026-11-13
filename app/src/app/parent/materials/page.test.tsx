import { expect, it, vi } from "vitest";
const redirect = vi.hoisted(() => vi.fn((path: string) => { throw Error(path); }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: async () => ({ familyId: "family" }) }));
import Page from "./page";
it.each([[undefined, "course"], ["video", "video"], ["book", "book"], ["materials", "materials"], ["https://other.test", "course"]])("keeps the old material bookmark inside the same Workshop (tab=%s)", async (tab, target) => {
  await expect(Page({ searchParams: Promise.resolve({ tab }) })).rejects.toThrow(`/parent/studio?tab=${target}`);
});
