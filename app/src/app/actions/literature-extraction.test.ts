import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S33 follow-up: `runLiteratureExtractionAction` — the parent-cabinet
 * trigger for `runLiteratureExtraction` (previously CLI-only). Covers the
 * input validation, the material/subject lookup that mirrors the CLI
 * script's own family resolution, the summary shape built from the (mocked)
 * extraction result, and the error path. Never calls the real AI.
 *
 * 2026-09-30 (PO: "хто ж ці id буде пам'ятати"): the action takes only
 * `materialId` now — `subjectId` is read off `materials.subject_id`.
 */

vi.mock("@/server/auth/guards", () => ({
  requireParentAccess: vi.fn(() => Promise.resolve({ ctx: {}, familyId: "fam-caller", via: "account" })),
}));

const runLiteratureExtraction = vi.fn();
vi.mock("@/server/lessons/literatureExtraction", () => ({
  runLiteratureExtraction: (...a: unknown[]) => runLiteratureExtraction(...a),
}));

const materialSingle = vi.fn();
const subjectMaybeSingle = vi.fn();

vi.mock("@/server/supabase/clients", () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => {
      expect(table).toBe("materials");
      return {
        select: () => ({
          eq: () => ({
            single: () => materialSingle(),
          }),
        }),
      };
    },
  })),
}));

vi.mock("@/server/db/family-scope", () => ({
  forFamily: vi.fn((familyId: string) => ({
    familyId,
    select: (table: string) => {
      expect(table).toBe("subjects");
      return {
        eq: () => ({
          maybeSingle: () => subjectMaybeSingle(),
        }),
      };
    },
  })),
}));

const { runLiteratureExtractionAction } = await import("./literature-extraction");
const { requireParentAccess } = await import("@/server/auth/guards");

const MATERIAL_ID = "11111111-1111-4111-8111-111111111111";
const SUBJECT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  runLiteratureExtraction.mockReset();
  materialSingle.mockReset();
  subjectMaybeSingle.mockReset();
  vi.mocked(requireParentAccess).mockClear();
});

describe("runLiteratureExtractionAction", () => {
  it("rejects a non-uuid material id without touching the DB or the extraction pipeline", async () => {
    const result = await runLiteratureExtractionAction("not-a-uuid");
    expect(result.status).toBe("error");
    expect(runLiteratureExtraction).not.toHaveBeenCalled();
  });

  it("gates on requireParentAccess before anything else", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "Кобзар", name: "Кобзар", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });
    runLiteratureExtraction.mockResolvedValue({ groups: 1, topics: [], calls: [], driveWriteFailures: [] });

    await runLiteratureExtractionAction(MATERIAL_ID);
    expect(requireParentAccess).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the material does not exist", async () => {
    materialSingle.mockResolvedValue({ data: null, error: { message: "not found" } });

    const result = await runLiteratureExtractionAction(MATERIAL_ID);
    expect(result.status).toBe("error");
    expect(runLiteratureExtraction).not.toHaveBeenCalled();
  });

  it("returns an error when the book has no subject attached", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: null, title: "Кобзар", name: "Кобзар", grade: 6 },
      error: null,
    });

    const result = await runLiteratureExtractionAction(MATERIAL_ID);
    expect(result.status).toBe("error");
    expect(runLiteratureExtraction).not.toHaveBeenCalled();
  });

  it("returns an error when the subject is not found for the book's family", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "Кобзар", name: "Кобзар", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: null });

    const result = await runLiteratureExtractionAction(MATERIAL_ID);
    expect(result.status).toBe("error");
    expect(runLiteratureExtraction).not.toHaveBeenCalled();
  });

  it("runs extraction with the book's own owner_family_id and subject_id (mirrors the CLI script) and summarizes the result", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "Кобзар", name: "fallback-name", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });
    runLiteratureExtraction.mockResolvedValue({
      groups: 3,
      topics: [
        { topicNo: 1, status: "active", failures: [], lessonId: "l1" },
        { topicNo: 2, status: "needs_review", failures: [{ field: "goalUk", reason: "обірвано" }], lessonId: "l2" },
      ],
      calls: [{ costUsd: 0.5 }, { costUsd: 0.25 }],
      driveWriteFailures: [{ topicNo: 2, reason: "Диск не підключено" }],
    });

    const result = await runLiteratureExtractionAction(MATERIAL_ID);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.summary).toEqual({
      materialTitle: "Кобзар",
      subjectName: "Зарубіжна література",
      groups: 3,
      topics: [
        { topicNo: 1, status: "active", failuresCount: 0 },
        { topicNo: 2, status: "needs_review", failuresCount: 1 },
      ],
      active: 1,
      needsReview: 1,
      driveWriteFailures: [{ topicNo: 2, reason: "Диск не підключено" }],
      totalCostUsd: 0.75,
    });

    expect(runLiteratureExtraction).toHaveBeenCalledTimes(1);
    const [scope, input] = runLiteratureExtraction.mock.calls[0]!;
    expect(scope.familyId).toBe("fam-book"); // the BOOK's family, not the caller's own
    expect(input).toEqual({
      familyId: "fam-book",
      subjectId: SUBJECT_ID,
      materialId: MATERIAL_ID,
      materialTitle: "Кобзар",
      subjectName: "Зарубіжна література",
      grade: 6,
    });
  });

  it("falls back to material.name when material.title is null", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: null, name: "Зарубіжна література 6", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });
    runLiteratureExtraction.mockResolvedValue({ groups: 1, topics: [], calls: [], driveWriteFailures: [] });

    const result = await runLiteratureExtractionAction(MATERIAL_ID);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.summary.materialTitle).toBe("Зарубіжна література 6");
  });

  it("catches a thrown error from the extraction pipeline and returns a generic error", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "Кобзар", name: "Кобзар", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });
    runLiteratureExtraction.mockRejectedValue(new Error("AI provider down"));

    const result = await runLiteratureExtractionAction(MATERIAL_ID);
    expect(result.status).toBe("error");
  });
});
