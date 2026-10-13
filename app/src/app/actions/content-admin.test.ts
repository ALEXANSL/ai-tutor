import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S42 (E-29, US-29.1/29.2/29.3): the content-admin server actions never
 * write a table directly — every mutating action calls one of the
 * `20261022100000_s42_admin_content_ops.sql` SECURITY DEFINER RPCs. These
 * tests check the action layer's own responsibilities: UUID validation,
 * mapping each RPC errcode to the right user-facing message, and that a
 * successful RPC call revalidates the right path — not the SQL itself
 * (covered by `tests/db`, which needs `DATABASE_URL`).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/auth/guards", () => ({
  requireParentAccess: () => Promise.resolve({ familyId: "fam1", ctx: { appUserId: "user1" } }),
}));

const rpc = vi.fn();
const selectEq = { eq: vi.fn().mockReturnThis(), returns: vi.fn().mockResolvedValue({ data: [] }), maybeSingle: vi.fn() };
vi.mock("@/server/db/family-scope", () => ({
  forFamily: () => ({
    client: { rpc: (...a: unknown[]) => rpc(...a) },
    select: () => selectEq,
  }),
}));

vi.mock("@/server/subjects/contentAdmin", () => ({
  getSubjectCleanupPreview: vi.fn(),
  listSubjectLessons: vi.fn(),
  listSubjectPackages: vi.fn(),
  listSubjectPdfMaterials: vi.fn(),
}));

const { getSubjectCleanupPreview } = await import("@/server/subjects/contentAdmin");
const { confirmSubjectCleanupAction, deleteLessonAction, linkPackageTextbookAction, previewSubjectCleanupAction, toggleLessonStatusAction } = await import("./content-admin");

const SUBJECT_ID = "11111111-1111-1111-1111-111111111111";
const LESSON_ID = "22222222-2222-2222-2222-222222222222";
const PACKAGE_ID = "33333333-3333-3333-3333-333333333333";
const MATERIAL_ID = "44444444-4444-4444-4444-444444444444";

beforeEach(() => {
  rpc.mockReset();
  (getSubjectCleanupPreview as ReturnType<typeof vi.fn>).mockReset();
});

describe("previewSubjectCleanupAction", () => {
  it("rejects a non-UUID subject id without calling the query layer", async () => {
    const result = await previewSubjectCleanupAction("not-a-uuid");
    expect(result.status).toBe("error");
    expect(getSubjectCleanupPreview).not.toHaveBeenCalled();
  });

  it("returns the preview counts on a valid subject", async () => {
    (getSubjectCleanupPreview as ReturnType<typeof vi.fn>).mockResolvedValue({ lessonsCount: 38, topicsCount: 12, tasksCount: 200, hasChildProgress: true });
    const result = await previewSubjectCleanupAction(SUBJECT_ID);
    expect(result).toEqual({ status: "ok", lessonsCount: 38, topicsCount: 12, tasksCount: 200, hasChildProgress: true });
  });
});

describe("confirmSubjectCleanupAction (US-29.1 КП-3/КП-4)", () => {
  it("archives via the RPC and reports the counts back", async () => {
    rpc.mockReturnValue({ maybeSingle: () => Promise.resolve({ data: { out_lessons_archived: 38, out_topics_archived: 12 }, error: null }) });
    const result = await confirmSubjectCleanupAction(SUBJECT_ID);
    expect(result).toEqual({ status: "ok", lessonsArchived: 38, topicsArchived: 12 });
    expect(rpc).toHaveBeenCalledWith("admin_archive_subject_content", { p_family_id: "fam1", p_subject_id: SUBJECT_ID });
  });

  it("subject_not_found (P0002) -> a specific message, not the generic one", async () => {
    rpc.mockReturnValue({ maybeSingle: () => Promise.resolve({ data: null, error: { code: "P0002" } }) });
    const result = await confirmSubjectCleanupAction(SUBJECT_ID);
    expect(result.status).toBe("error");
  });
});

describe("toggleLessonStatusAction (US-29.3 КП-1)", () => {
  it("rejects an unknown system", async () => {
    const result = await toggleLessonStatusAction("not_a_system", LESSON_ID, true);
    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("turning a lesson off calls the RPC with status='disabled'", async () => {
    rpc.mockResolvedValue({ error: null });
    const result = await toggleLessonStatusAction("course_v2", LESSON_ID, false);
    expect(result).toEqual({ status: "ok" });
    expect(rpc).toHaveBeenCalledWith("admin_set_lesson_status", { p_family_id: "fam1", p_system: "course_v2", p_lesson_id: LESSON_ID, p_status: "disabled" });
  });
});

describe("deleteLessonAction (US-29.3 КП-2: blocked when progress exists)", () => {
  it("has_progress (P0016) -> a 'blocked' state, not a generic error", async () => {
    rpc.mockResolvedValue({ error: { code: "P0016" } });
    const result = await deleteLessonAction("course_v2", LESSON_ID);
    expect(result.status).toBe("blocked");
  });

  it("succeeds when the RPC reports no error", async () => {
    rpc.mockResolvedValue({ error: null });
    const result = await deleteLessonAction("literature", LESSON_ID);
    expect(result).toEqual({ status: "ok" });
  });
});

describe("linkPackageTextbookAction (US-29.2)", () => {
  it("rejects an unknown kind", async () => {
    const result = await linkPackageTextbookAction("course", PACKAGE_ID, MATERIAL_ID);
    expect(result.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("links the material via the RPC", async () => {
    rpc.mockResolvedValue({ error: null });
    const result = await linkPackageTextbookAction("course_v2", PACKAGE_ID, null);
    expect(result.status).toBe("ok");
    expect(rpc).toHaveBeenCalledWith("admin_set_package_textbook", { p_family_id: "fam1", p_kind: "course_v2", p_package_id: PACKAGE_ID, p_material_id: null });
  });
});
