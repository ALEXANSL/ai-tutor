import { describe, expect, it, vi } from "vitest";

/**
 * PO feedback 2026-10-01 (first real lesson, Гоголь): covers the two new
 * things the view model exposes to the child UI — `materialId` (so the
 * lesson screen can link to the full-book reader, which previously had no
 * entry point) and `work.authorBioUk`/`work.otherWorksUk` (previously
 * dropped entirely). `@/server/db/family-scope`'s `forFamily` is mocked —
 * no real Supabase call.
 */

type Row = Record<string, unknown>;

function chain(result: { data: unknown; error?: unknown }) {
  const builder = {
    eq: () => builder,
    order: () => builder,
    maybeSingle: async () => result,
    returns: async () => result,
  };
  return builder;
}

let lessonRow: Row | null = null;
let testRow: Row | null = null;

vi.mock("@/server/db/family-scope", () => ({
  forFamily: () => ({
    select: (table: string) => {
      if (table === "literature_lessons") return chain({ data: lessonRow });
      if (table === "literature_lesson_tests") return chain({ data: testRow });
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { getLiteratureLessonView } = await import("./literatureView");

function baseLessonRow(over: Row = {}): Row {
  return {
    id: "lesson-1",
    material_id: "material-42",
    topic_no: 1,
    section_title: null,
    title: "Микола Гоголь. «Ніч перед Різдвом»",
    textbook_page_from: 10,
    textbook_page_to: 20,
    pdf_page_from: 11,
    pdf_page_to: 21,
    goal_uk: "Ознайомити з повістю.",
    key_concepts: ["Повість"],
    explanation_md: "Матеріал для пояснення.",
    work_title_uk: "Ніч перед Різдвом",
    work_excerpts_uk: "«Останній день перед Різдвом минув.»",
    work_summary_uk: "Коротко про сюжет.",
    work_characters_uk: "Вакула, Оксана.",
    work_idea_uk: "Боротьба добра і зла.",
    work_author_bio_uk: null,
    work_other_works_uk: null,
    work_full_text_drive_file_id: null,
    sublessons: [],
    teacher_note_uk: "",
    status: "active",
    ...over,
  };
}

describe("getLiteratureLessonView", () => {
  it("returns null when no lesson row matches", async () => {
    lessonRow = null;
    testRow = null;
    const result = await getLiteratureLessonView("fam1", "lesson-404");
    expect(result).toBeNull();
  });

  it("exposes materialId so the UI can link to the full-book reader (PO feedback 2026-10-01)", async () => {
    lessonRow = baseLessonRow();
    testRow = { questions: [] };
    const result = await getLiteratureLessonView("fam1", "lesson-1");
    expect(result?.materialId).toBe("material-42");
  });

  it("exposes work.authorBioUk/otherWorksUk when the DB row has them", async () => {
    lessonRow = baseLessonRow({
      work_author_bio_uk: "Гоголь народився 1809 р. у Великих Сорочинцях.",
      work_other_works_uk: "Також написав «Тараса Бульбу» і «Ревізора».",
    });
    testRow = { questions: [] };
    const result = await getLiteratureLessonView("fam1", "lesson-1");
    expect(result?.work?.authorBioUk).toBe("Гоголь народився 1809 р. у Великих Сорочинцях.");
    expect(result?.work?.otherWorksUk).toBe("Також написав «Тараса Бульбу» і «Ревізора».");
  });

  it("exposes authorBioUk/otherWorksUk as null when the DB row has none (never invented on the read path)", async () => {
    lessonRow = baseLessonRow();
    testRow = { questions: [] };
    const result = await getLiteratureLessonView("fam1", "lesson-1");
    expect(result?.work?.authorBioUk).toBeNull();
    expect(result?.work?.otherWorksUk).toBeNull();
  });
});
