import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const catalog = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: async () => ({ familyId: "own-family" }) }));
vi.mock("@/server/studio/catalog", () => ({ studioCatalog: catalog }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/studio", () => ({ setStudioAccessAction: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
import Page from "./page";
it("groups subjects and standalone projects and exposes editing plus restore on the catalogue card", async () => {
  const base = { revision: 2, published: true, visible: false, lessonCount: 1, spentUsd: 0.2, state: "withdrawn" };
  catalog.mockResolvedValue({ subjects: [], page: 0, hasMore: true, items: [{ ...base, id: "old-project", title: "Безпека", subjectId: "subject", subjectName: "Інформатика" }, { ...base, id: "course", title: "Roblox", subjectId: null, subjectName: null }] });
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ q: "", subject: "" }) }));
  expect(catalog).toHaveBeenCalledWith("own-family", { q: "", subject: "", page: 0 });
  expect(html).toContain("Інформатика"); expect(html).toContain("Самостійні курси й уроки");
  expect(html).toContain('/parent/studio/old-project?edit=1'); expect(html).toContain("Редагувати"); expect(html).toContain("Увімкнути для дитини"); expect(html).toContain("Наступна сторінка");
});
