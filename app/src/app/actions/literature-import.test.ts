import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S33 follow-up ($0 manual-course importer, PO decision 2026-09-30):
 * `importLiteratureCourseAction` — mirrors `literature-extraction.test.ts`'s
 * mocking approach (same `requireParentAccess`/`createServiceClient`/
 * `forFamily` shape), but mocks `persistLiteratureTopic` instead of
 * `runLiteratureExtraction`, and feeds it a REAL zipped fixture course
 * (`literatureImport.ts`'s own fixtures) instead of a mocked parse result —
 * so this test also proves the real parser's output is accepted end-to-end.
 * Never calls any AI.
 */

vi.mock("@/server/auth/guards", () => ({
  requireParentAccess: vi.fn(() => Promise.resolve({ ctx: {}, familyId: "fam-caller", via: "account" })),
}));

const persistLiteratureTopic = vi.fn();
vi.mock("@/server/lessons/literatureExtraction", () => ({
  persistLiteratureTopic: (...a: unknown[]) => persistLiteratureTopic(...a),
}));

const materialSingle = vi.fn();
const subjectMaybeSingle = vi.fn();

vi.mock("@/server/supabase/clients", () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => {
      expect(table).toBe("materials");
      return { select: () => ({ eq: () => ({ single: () => materialSingle() }) }) };
    },
  })),
}));

vi.mock("@/server/db/family-scope", () => ({
  forFamily: vi.fn((familyId: string) => ({
    familyId,
    select: (table: string) => {
      expect(table).toBe("subjects");
      return { eq: () => ({ maybeSingle: () => subjectMaybeSingle() }) };
    },
  })),
}));

const { importLiteratureCourseAction } = await import("./literature-import");
const { requireParentAccess } = await import("@/server/auth/guards");

const MATERIAL_ID = "11111111-1111-4111-8111-111111111111";
const SUBJECT_ID = "22222222-2222-4222-8222-222222222222";

const FIXTURES = join(process.cwd(), "src/server/lessons/__fixtures__/zarlit-6");
function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}
function fixtureZipFile(): File {
  const zip = zipSync({
    "lessons/01.md": strToU8(readFixture("lessons/01.md")),
    "lessons/03.md": strToU8(readFixture("lessons/03.md")),
    "lessons/05.md": strToU8(readFixture("lessons/05.md")),
    "tests/01.json": strToU8(readFixture("tests/01.json")),
    "tests/03.json": strToU8(readFixture("tests/03.json")),
    "tests/05.json": strToU8(readFixture("tests/05.json")),
  });
  return new File([zip], "course.zip", { type: "application/zip" });
}

function formDataWith(materialId: string, file: File | null): FormData {
  const fd = new FormData();
  fd.set("materialId", materialId);
  if (file) fd.set("file", file);
  return fd;
}

beforeEach(() => {
  persistLiteratureTopic.mockReset();
  materialSingle.mockReset();
  subjectMaybeSingle.mockReset();
  vi.mocked(requireParentAccess).mockClear();
});

describe("importLiteratureCourseAction", () => {
  it("rejects a non-uuid material id without touching the DB or parsing anything", async () => {
    const result = await importLiteratureCourseAction(formDataWith("not-a-uuid", fixtureZipFile()));
    expect(result.status).toBe("error");
    expect(persistLiteratureTopic).not.toHaveBeenCalled();
  });

  it("rejects when no file is attached", async () => {
    const result = await importLiteratureCourseAction(formDataWith(MATERIAL_ID, null));
    expect(result.status).toBe("error");
    expect(persistLiteratureTopic).not.toHaveBeenCalled();
  });

  it("gates on requireParentAccess", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "Зарубіжна література 6", name: "x", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });
    persistLiteratureTopic.mockResolvedValue({ topicNo: 1, status: "active", failures: [], lessonId: "l1" });

    await importLiteratureCourseAction(formDataWith(MATERIAL_ID, fixtureZipFile()));
    expect(requireParentAccess).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the material does not exist", async () => {
    materialSingle.mockResolvedValue({ data: null, error: { message: "not found" } });
    const result = await importLiteratureCourseAction(formDataWith(MATERIAL_ID, fixtureZipFile()));
    expect(result.status).toBe("error");
    expect(persistLiteratureTopic).not.toHaveBeenCalled();
  });

  it("returns an error when the book has no subject attached", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: null, title: "x", name: "x", grade: 6 },
      error: null,
    });
    const result = await importLiteratureCourseAction(formDataWith(MATERIAL_ID, fixtureZipFile()));
    expect(result.status).toBe("error");
    expect(persistLiteratureTopic).not.toHaveBeenCalled();
  });

  it("parses the real fixture zip and persists every topic, in topicNo order, never calling any AI", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "Зарубіжна література 6", name: "x", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });
    persistLiteratureTopic.mockImplementation((_scope, _ctx, topic) => Promise.resolve({ topicNo: topic.topicNo, status: "active", failures: [], lessonId: `l${topic.topicNo}` }));

    const result = await importLiteratureCourseAction(formDataWith(MATERIAL_ID, fixtureZipFile()));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.summary.materialTitle).toBe("Зарубіжна література 6");
    expect(result.summary.subjectName).toBe("Зарубіжна література");
    expect(result.summary.topics.map((t) => t.topicNo)).toEqual([1, 3, 5]);
    expect(result.summary.active).toBe(3);
    expect(result.summary.needsReview).toBe(0);

    expect(persistLiteratureTopic).toHaveBeenCalledTimes(3);
    for (const call of persistLiteratureTopic.mock.calls) {
      const [scope, ctx, , , model, driveFileId] = call;
      expect(scope.familyId).toBe("fam-book"); // the BOOK's family, not the caller's own
      expect(ctx).toEqual({ subjectId: SUBJECT_ID, materialId: MATERIAL_ID, grade: 6 });
      expect(model).toBe("manual_import"); // never a real AI model id
      expect(driveFileId).toBeNull(); // no source chunks to slice a full-text file from
    }
  });

  it("returns an error when the zip has no lessons/NN.md files", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "x", name: "x", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });

    const emptyZip = new File([zipSync({ "README.md": strToU8("hi") })], "course.zip", { type: "application/zip" });
    const result = await importLiteratureCourseAction(formDataWith(MATERIAL_ID, emptyZip));
    expect(result.status).toBe("error");
    expect(persistLiteratureTopic).not.toHaveBeenCalled();
  });

  it("catches a thrown error from persistLiteratureTopic and includes its real message", async () => {
    materialSingle.mockResolvedValue({
      data: { id: MATERIAL_ID, owner_family_id: "fam-book", subject_id: SUBJECT_ID, title: "x", name: "x", grade: 6 },
      error: null,
    });
    subjectMaybeSingle.mockResolvedValue({ data: { id: SUBJECT_ID, name_uk: "Зарубіжна література" } });
    persistLiteratureTopic.mockRejectedValue(new Error("DB is down"));

    const result = await importLiteratureCourseAction(formDataWith(MATERIAL_ID, fixtureZipFile()));
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.message).toContain("DB is down");
  });
});
