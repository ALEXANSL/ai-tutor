import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ auth: vi.fn(), catalog: vi.fn(), drafts: vi.fn(), read: vi.fn(), books: vi.fn(), subjects: vi.fn(), subject: vi.fn(), uploads: vi.fn(), scope: vi.fn(), props: [] as Record<string, unknown>[], material: null as Record<string, unknown> | null }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.auth }));
vi.mock("@/server/studio/catalog", () => ({ studioCatalog: f.catalog }));
vi.mock("@/server/studio/drafts", () => ({ readStudioFormDraft: f.read, listStudioFormDrafts: f.drafts }));
vi.mock("@/server/books/queries", () => ({ listBooks: f.books, listSubjects: f.subjects }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("@/server/drive/service", () => ({ isUploadsFolderConfigured: f.uploads }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: f.scope }));
vi.mock("@/components/parent/studio/StudioCreate", () => ({ StudioCreate: (props: Record<string, unknown>) => { f.props.push(props); return <div>Draft form</div>; } }));
vi.mock("@/components/parent/studio/StudioImports", () => ({ StudioImports: () => null }));
vi.mock("@/components/parent/studio/StudioWorkQueue", () => ({ StudioWorkQueue: () => null }));
vi.mock("@/components/parent/studio/StudioAccessButton", () => ({ StudioAccessButton: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not_found"); }, redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
import StudioPage from "./page";
import StudioNewPage from "./new/page";

const familyId = "77777777-7777-4777-8777-777777777777";
const draftId = "55555555-5555-4555-8555-555555555555";
const projectId = "66666666-6666-4666-8666-666666666666";
const materialId = "33333333-3333-4333-8333-333333333333";
const subjectId = "11111111-1111-4111-8111-111111111111";
const draft = { id: draftId, revision: 2, values: { mode: "course", targetLanguage: null, title: "Незавершений курс", idea: "Ще обдумую мету", sourceText: "", age: 12, grade: 7, lessonCount: 4, minutes: 20, budgetUsd: 3, subjectId: null, topicId: null, materialId: null, pageFrom: null, pageTo: null }, projectId: null, createdAt: "2026-11-18T08:00:00Z", updatedAt: "2026-11-18T08:00:00Z" };
const catalog = { items: [{ id: projectId, revision: 3, title: "Готовий урок", subjectId: null, subjectName: null, state: "ready", published: false, visible: false, lessonCount: 1, spentUsd: 0.25 }], subjects: [], page: 0, hasMore: false };
beforeEach(() => {
  [f.auth, f.catalog, f.drafts, f.read, f.books, f.subjects, f.subject, f.uploads, f.scope].forEach(mock => mock.mockReset());
  f.props.length = 0;
  f.material = null;
  f.auth.mockResolvedValue({ familyId });
  f.catalog.mockResolvedValue(catalog);
  f.drafts.mockResolvedValue([draft]);
  f.read.mockResolvedValue(draft);
  f.books.mockResolvedValue([]);
  f.subjects.mockResolvedValue([{ id: subjectId, code: "math", name: "Математика" }]);
  f.subject.mockResolvedValue(null);
  f.uploads.mockResolvedValue(false);
  f.scope.mockImplementation(() => ({ select: (table: string) => {
    const chain = { eq: () => chain, limit: () => chain, maybeSingle: async () => ({ data: table === "academic_years" ? { grade: 7 } : f.material }) };
    return chain;
  } }));
});

describe("Studio draft server pages", () => {
  it("lists unlaunched form drafts separately from AI projects", async () => {
    f.drafts.mockResolvedValue([draft, { ...draft, id: "88888888-8888-4888-8888-888888888888", projectId }]);
    const html = renderToStaticMarkup(await StudioPage({ searchParams: Promise.resolve({}) }));
    expect(f.drafts).toHaveBeenCalledWith(familyId);
    expect(html).toContain("Чернетка — не запущено");
    expect(html).toContain(`/parent/studio/new?draft=${draftId}`);
    expect(html).not.toContain("new?draft=88888888");
    expect(html).toContain(`/parent/studio/${projectId}`);
    expect(html).toContain("Готовий урок");
  });

  it("keeps existing projects accessible if the separate draft list fails", async () => {
    f.drafts.mockRejectedValueOnce(new Error("temporary database error"));
    const html = renderToStaticMarkup(await StudioPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Не вдалося завантажити збережене заповнення");
    expect(html).toContain("Готовий урок");
  });

  it("loads a family-owned draft and passes an opaque family recovery key", async () => {
    renderToStaticMarkup(await StudioNewPage({ searchParams: Promise.resolve({ draft: draftId, saved: "1", subject: subjectId }) }));
    expect(f.read).toHaveBeenCalledWith(familyId, draftId);
    expect(f.props[0]).toEqual(expect.objectContaining({ initialDraft: draft, initialSaved: true }));
    expect(f.props[0]!.initialSubject).toBeUndefined();
    expect(f.props[0]!.storageKey).toMatch(/^studio-form:[a-f0-9]{32}$/);
    expect(f.props[0]!.storageKey).not.toContain(familyId);
  });

  it("preserves a draft's uploaded source that has not appeared in the library list", async () => {
    const saved = { ...draft, values: { ...draft.values, materialId } };
    f.read.mockResolvedValueOnce(saved);
    f.material = { id: materialId, title: "Завантажений посібник", name: "book.pdf" };
    renderToStaticMarkup(await StudioNewPage({ searchParams: Promise.resolve({ draft: draftId }) }));
    expect(f.props[0]!.books).toContainEqual({ id: materialId, title: "Завантажений посібник" });
    expect(f.props[0]!.initialDraft).toEqual(saved);
    expect(f.scope.mock.calls.every(([family]) => family === familyId)).toBe(true);
  });

  it("does not turn a missing or foreign draft into a blank editable form", async () => {
    f.read.mockResolvedValueOnce(null);
    await expect(StudioNewPage({ searchParams: Promise.resolve({ draft: draftId }) })).rejects.toThrow("not_found");
    expect(f.props).toHaveLength(0);
  });

  it("reopens an already launched draft at the same project rather than offering another launch", async () => {
    f.read.mockResolvedValueOnce({ ...draft, projectId });
    await expect(StudioNewPage({ searchParams: Promise.resolve({ draft: draftId }) })).rejects.toThrow(`redirect:/parent/studio/${projectId}`);
    expect(f.books).not.toHaveBeenCalled();
  });
});
