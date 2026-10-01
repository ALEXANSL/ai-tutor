import { describe, expect, it, vi } from "vitest";
import type { LiteratureTopicOut } from "./literature-schema";

/**
 * S33 (PO decision 2026-09-30, corrected three times same day — final
 * architecture: excerpts+adaptation in our DB, the work's full text as a
 * small file on the family's own Drive): tests for the new, parallel
 * literature-extraction path. `@/server/ai/router` and `@/server/drive/workText`
 * are mocked — no real Anthropic/OpenAI call, no real Drive call. Covers:
 * section grouping never splits a section mid-way, the deterministic
 * content_qa gate, persistence (reuse-or-create the `topics` row, upsert
 * `literature_lessons`/`literature_lesson_tests`), and the full-text Drive
 * write (success + a failure that must not block saving the lesson itself).
 */

const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...args: unknown[]) => callStructured(...args) }));

const saveWorkFullTextToDrive = vi.fn();
vi.mock("@/server/drive/workText", () => ({ saveWorkFullTextToDrive: (...args: unknown[]) => saveWorkFullTextToDrive(...args) }));

const {
  groupSectionsForExtraction,
  checkLiteratureTopicContentQa,
  extractTopicsForGroup,
  persistLiteratureTopic,
  runLiteratureExtraction,
} = await import("./literatureExtraction");

function topic(over: Partial<LiteratureTopicOut> = {}): LiteratureTopicOut {
  return {
    topicNo: 5,
    sectionTitleUk: "Пригоди і фантастика",
    titleUk: "Даніель Дефо. «Пригоди Робінзона Крузо»",
    textbookPageFrom: 36,
    textbookPageTo: 75,
    pdfPageFrom: 37,
    pdfPageTo: 76,
    goalUk: "Ознайомити з романом і поняттям робінзонади.",
    keyConceptsUk: ["Роман — великий епічний твір.", "Робінзонада — твори про виживання."],
    explanationMdUk: "Дефо (1660–1731) — англійський письменник і підприємець.",
    work: {
      titleUk: "Пригоди Робінзона Крузо",
      excerptsUk: "«Я, нещасний Робінзон Крузо, зазнавши корабельної аварії...» — початок щоденника героя.",
      summaryUk: "Робінзон потрапляє на безлюдний острів і облаштовує на ньому життя.",
      charactersUk: "Робінзон Крузо, П'ятниця.",
      ideaUk: "Праця й терпіння допомагають вистояти в скрутних обставинах.",
    },
    sublessons: [
      {
        no: "5.1",
        titleUk: "Даніель Дефо: життя і творчість",
        questionGroups: [
          {
            labelUk: "Запитання і завдання",
            page: 37,
            pdfPage: 38,
            items: [
              { number: "1", textUk: "Як формувався характер Дефо?" },
              { number: "2", textUk: "Що вело його в житті?" },
            ],
          },
        ],
      },
    ],
    teacherNoteUk: "Міжпредметний зв'язок з історією.",
    test: {
      questions: [
        { id: "05-q1", type: "single", questionUk: "Хто прототип Робінзона?", options: ["Селкірк", "Кук"], answer: 0, explanationUk: "Александр Селкірк — реальний моряк." },
        { id: "05-q2", type: "truefalse", questionUk: "Робінзон одразу підкорився батькові.", answer: 1, explanationUk: "Він пішов у море всупереч волі батька." },
        { id: "05-q3", type: "open", questionUk: "Чому Робінзон вів щоденник?", expectedAnswerUk: "Щоб оцінити становище.", explanationUk: "Щоденник допомагав тверезо оцінити ситуацію." },
      ],
    },
    ...over,
  };
}

describe("groupSectionsForExtraction", () => {
  const sections = [
    { id: "s1", title: "Вступ", page_from: 1, page_to: 5, sort_order: 1 },
    { id: "s2", title: "Міфи", page_from: 6, page_to: 10, sort_order: 2 },
    { id: "s3", title: "Робінзон", page_from: 11, page_to: 20, sort_order: 3 },
  ];
  const chunks = [
    { page: 2, text: "a".repeat(50), ordinal: 1 },
    { page: 7, text: "b".repeat(50), ordinal: 2 },
    { page: 12, text: "c".repeat(50), ordinal: 3 },
  ];

  it("keeps every section in one group when the budget is generous", () => {
    const groups = groupSectionsForExtraction(sections, chunks, 10_000);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("splits into multiple groups on a section boundary, never mid-section", () => {
    const groups = groupSectionsForExtraction(sections, chunks, 120);
    expect(groups.length).toBeGreaterThan(1);
    // Every section appears whole in exactly one group.
    const seen = groups.flatMap((g) => g.sections.map((s) => s.id));
    expect(seen).toEqual(["s1", "s2", "s3"]);
    // No group's text is split across a section boundary (each section's
    // full body text — the 50 'x' chars — appears intact in its group).
    for (const g of groups) {
      for (const s of g.sections) {
        const chunk = chunks.find((c) => (s.id === "s1" ? c.page === 2 : s.id === "s2" ? c.page === 7 : c.page === 12))!;
        expect(g.text).toContain(chunk.text);
      }
    }
  });

  it("skips a section with no indexed chunks", () => {
    const withEmpty = [...sections, { id: "s4", title: "Empty", page_from: 21, page_to: 25, sort_order: 4 }];
    const groups = groupSectionsForExtraction(withEmpty, chunks, 10_000);
    const seenIds = groups.flatMap((g) => g.sections.map((s) => s.id));
    expect(seenIds).not.toContain("s4");
  });

  it("always sends a single oversized section whole rather than splitting it", () => {
    const bigChunks = [{ page: 2, text: "z".repeat(500), ordinal: 1 }];
    const groups = groupSectionsForExtraction([sections[0]!], bigChunks, 100);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.text).toContain("z".repeat(500));
  });
});

describe("checkLiteratureTopicContentQa", () => {
  it("passes a well-formed topic", () => {
    const result = checkLiteratureTopicContentQa(topic());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("flags a truncated explanation (dangling conjunction)", () => {
    const result = checkLiteratureTopicContentQa(topic({ explanationMdUk: "Дефо мав бурхливе життя і" }));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.field === "explanationMdUk")).toBe(true);
  });

  it("flags a truncated work excerpt", () => {
    const result = checkLiteratureTopicContentQa(
      topic({ work: { titleUk: "X", excerptsUk: "Уривок обривається на", summaryUk: "Нормальний переказ." } }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.field === "work.excerptsUk")).toBe(true);
  });

  it("flags a truncated textbook question", () => {
    const t = topic();
    t.sublessons[0]!.questionGroups[0]!.items[0]!.textUk = "Як формувався характер і";
    const result = checkLiteratureTopicContentQa(t);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.field.includes("questionGroups"))).toBe(true);
  });

  it("never requires a work for a theory-only topic (work: null)", () => {
    const result = checkLiteratureTopicContentQa(topic({ work: null }));
    expect(result.ok).toBe(true);
  });

  it("passes when optional work.authorBioUk/otherWorksUk are absent", () => {
    const result = checkLiteratureTopicContentQa(topic());
    expect(result.ok).toBe(true);
  });

  it("flags a truncated work.authorBioUk when present", () => {
    const result = checkLiteratureTopicContentQa(
      topic({ work: { ...topic().work!, authorBioUk: "Дефо народився у" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.field === "work.authorBioUk")).toBe(true);
  });

  it("flags a truncated work.otherWorksUk when present", () => {
    const result = checkLiteratureTopicContentQa(
      topic({ work: { ...topic().work!, otherWorksUk: "Дефо також написав і" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.field === "work.otherWorksUk")).toBe(true);
  });
});

describe("extractTopicsForGroup", () => {
  it("fills the prompt with subject/grade/material/book text and returns the call log", async () => {
    callStructured.mockResolvedValueOnce({
      result: { topics: [topic()] },
      model: { provider: "anthropic", model: "claude-opus-5-5" },
      costUsd: 0.42,
    });

    const group = { sections: [{ id: "s1", title: "Пригоди і фантастика", page_from: 36, page_to: 75, sort_order: 5 }], text: "[стор. 36] Даніель Дефо..." };
    const { topics, call } = await extractTopicsForGroup(
      { familyId: "fam1", subjectId: "subj1", materialId: "mat1", materialTitle: "Зарубіжна література 6 клас", subjectName: "Зарубіжна література", grade: 6 },
      group,
    );

    expect(topics).toHaveLength(1);
    expect(topics[0]!.topicNo).toBe(5);
    expect(call).toEqual({ role: "literature_extraction", provider: "anthropic", model: "claude-opus-5-5", costUsd: 0.42 });

    const [role, req, ctx] = callStructured.mock.calls[0]!;
    expect(role).toBe("literature_extraction");
    expect(req.prompt).toContain("[стор. 36] Даніель Дефо...");
    expect(req.prompt).toContain("Зарубіжна література 6 клас");
    expect(req.prompt).toContain("6");
    expect(ctx).toEqual({ familyId: "fam1", ref: { table: "materials", id: "mat1" } });
  });
});

/** A minimal fluent stand-in for the chainable methods `literatureExtraction.ts` calls on `scope`/`scope.client` (mirrors `generate.test.ts`'s helper). */
function fluent(terminal: { returns?: unknown[]; single?: unknown; maybeSingle?: unknown }) {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "returns") return async () => ({ data: terminal.returns ?? [], error: null });
      if (prop === "single") return async () => ({ data: terminal.single ?? null, error: terminal.single ? null : { message: "no row" } });
      if (prop === "maybeSingle") return async () => ({ data: terminal.maybeSingle ?? null, error: null });
      return () => proxy;
    },
  };
  const proxy = new Proxy({}, handler);
  return proxy as never;
}

describe("persistLiteratureTopic", () => {
  function makeScope(opts: { existingLesson?: { id: string; topic_id: string | null } | null }) {
    const inserted: Record<string, Record<string, unknown>> = {};
    const scope = {
      familyId: "fam1",
      select: (table: string) => {
        if (table === "literature_lessons") return fluent({ maybeSingle: opts.existingLesson ?? null });
        return fluent({ maybeSingle: null, returns: [] });
      },
      client: {
        from: (table: string) => {
          if (table === "topics") {
            return {
              insert: (row: Record<string, unknown>) => {
                inserted.topics = row;
                return { select: () => fluent({ single: { id: "topic-new" } }) };
              },
            };
          }
          if (table === "literature_lessons") {
            return {
              upsert: (row: Record<string, unknown>) => {
                inserted.literature_lessons = row;
                return { select: () => fluent({ single: { id: "lesson-1" } }) };
              },
            };
          }
          if (table === "literature_lesson_tests") {
            return {
              upsert: (row: Record<string, unknown>) => {
                inserted.literature_lesson_tests = row;
                // Real code `await`s this directly (no `.select()`/`.single()`
                // terminal call) — a plain resolved promise, not the `fluent()`
                // proxy (whose `then` trap would otherwise hang forever).
                return Promise.resolve({ error: null });
              },
            };
          }
          throw new Error(`unexpected table ${table}`);
        },
      },
    };
    return { scope, inserted };
  }

  it("creates a new topics row when no literature_lessons row exists yet, and stores the given work_full_text_drive_file_id (never the text itself)", async () => {
    const { scope, inserted } = makeScope({ existingLesson: null });
    const result = await persistLiteratureTopic(scope as never, { subjectId: "subj1", materialId: "mat1", grade: 6 }, topic(), 3, "claude-opus-5-5", "drive-file-abc");

    expect(result).toEqual({ topicNo: 5, status: "active", failures: [], lessonId: "lesson-1" });
    expect(inserted.topics).toMatchObject({ subject_id: "subj1", material_id: "mat1", title: topic().titleUk, page_from: 36, page_to: 75, sort_order: 3, grade: 6 });
    expect(inserted.literature_lessons).toMatchObject({
      topic_id: "topic-new",
      topic_no: 5,
      status: "active",
      work_excerpts_uk: topic().work!.excerptsUk,
      work_full_text_drive_file_id: "drive-file-abc",
    });
    expect(JSON.stringify(inserted.literature_lessons)).not.toContain("Уривок"); // sanity: no full-work-text field ever leaks into the DB row
    expect(inserted.literature_lesson_tests).toMatchObject({ lesson_id: "lesson-1", questions: topic().test.questions });
  });

  it("writes work_author_bio_uk/work_other_works_uk when the topic provides them, and null when it doesn't (PO feedback 2026-10-01)", async () => {
    const { scope, inserted } = makeScope({ existingLesson: null });
    const withBio = topic({
      work: { ...topic().work!, authorBioUk: "Дефо народився 1660 р. у родині торговця.", otherWorksUk: "Також написав «Щоденник чумного року»." },
    });
    await persistLiteratureTopic(scope as never, { subjectId: "subj1", materialId: "mat1", grade: 6 }, withBio, 3, "claude-opus-5-5");

    expect(inserted.literature_lessons).toMatchObject({
      work_author_bio_uk: "Дефо народився 1660 р. у родині торговця.",
      work_other_works_uk: "Також написав «Щоденник чумного року».",
    });
  });

  it("defaults work_author_bio_uk/work_other_works_uk to null when the topic omits them", async () => {
    const { scope, inserted } = makeScope({ existingLesson: null });
    await persistLiteratureTopic(scope as never, { subjectId: "subj1", materialId: "mat1", grade: 6 }, topic(), 3, "claude-opus-5-5");

    expect(inserted.literature_lessons).toMatchObject({ work_author_bio_uk: null, work_other_works_uk: null });
  });

  it("defaults work_full_text_drive_file_id to null when the caller passes none (e.g. topic has no work, or the Drive write failed)", async () => {
    const { scope, inserted } = makeScope({ existingLesson: null });
    await persistLiteratureTopic(scope as never, { subjectId: "subj1", materialId: "mat1", grade: 6 }, topic(), 3, "claude-opus-5-5");
    expect(inserted.literature_lessons).toMatchObject({ work_full_text_drive_file_id: null });
  });

  it("reuses the existing topic_id when a literature_lessons row already exists (re-run is idempotent)", async () => {
    const { scope, inserted } = makeScope({ existingLesson: { id: "lesson-1", topic_id: "topic-existing" } });
    await persistLiteratureTopic(scope as never, { subjectId: "subj1", materialId: "mat1", grade: 6 }, topic(), 3, "claude-opus-5-5");

    expect(inserted.topics).toBeUndefined(); // no new topics row created
    expect(inserted.literature_lessons).toMatchObject({ topic_id: "topic-existing" });
  });

  it("marks the lesson needs_review when content_qa fails, but still saves it (never throws)", async () => {
    const { scope, inserted } = makeScope({ existingLesson: null });
    const broken = topic({ explanationMdUk: "Обірваний текст і" });
    const result = await persistLiteratureTopic(scope as never, { subjectId: "subj1", materialId: "mat1", grade: 6 }, broken, 1, "claude-opus-5-5");

    expect(result.status).toBe("needs_review");
    expect(result.failures.length).toBeGreaterThan(0);
    expect(inserted.literature_lessons).toMatchObject({ status: "needs_review" });
  });
});

describe("runLiteratureExtraction", () => {
  it("groups, calls the AI role per group, writes each topic's work full text to Drive, and persists every returned topic in order", async () => {
    callStructured.mockResolvedValueOnce({
      result: { topics: [topic({ topicNo: 5 }), topic({ topicNo: 6, titleUk: "Наступна тема" })] },
      model: { provider: "anthropic", model: "claude-opus-5-5" },
      costUsd: 0.1,
    });
    saveWorkFullTextToDrive.mockReset().mockResolvedValueOnce("drive-file-5").mockResolvedValueOnce("drive-file-6");

    const savedTopicNos: number[] = [];
    const scope = {
      familyId: "fam1",
      select: (table: string) => {
        if (table === "material_sections") return fluent({ returns: [{ id: "s1", title: "Пригоди і фантастика", page_from: 36, page_to: 75, sort_order: 5 }] });
        if (table === "chunks") return fluent({ returns: [{ page: 40, text: "Даніель Дефо ...", ordinal: 1 }] });
        if (table === "literature_lessons") return fluent({ maybeSingle: null });
        return fluent({ returns: [] });
      },
      client: {
        from: (table: string) => {
          if (table === "topics") return { insert: () => ({ select: () => fluent({ single: { id: "topic-x" } }) }) };
          if (table === "literature_lessons") {
            return {
              upsert: (row: Record<string, unknown>) => {
                savedTopicNos.push(row.topic_no as number);
                return { select: () => fluent({ single: { id: `lesson-${row.topic_no}` } }) };
              },
            };
          }
          if (table === "literature_lesson_tests") return { upsert: () => Promise.resolve({ error: null }) };
          throw new Error(`unexpected table ${table}`);
        },
      },
    };

    const result = await runLiteratureExtraction(scope as never, {
      familyId: "fam1",
      subjectId: "subj1",
      materialId: "mat1",
      materialTitle: "Зарубіжна література 6 клас",
      subjectName: "Зарубіжна література",
      grade: 6,
    });

    expect(result.groups).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.topics.map((t) => t.topicNo)).toEqual([5, 6]);
    expect(savedTopicNos).toEqual([5, 6]);
    expect(result.driveWriteFailures).toEqual([]);
    expect(saveWorkFullTextToDrive).toHaveBeenCalledTimes(2);
    expect(saveWorkFullTextToDrive).toHaveBeenCalledWith("fam1", expect.stringContaining("Тема 5"), expect.stringContaining("Даніель Дефо"));
  });

  it("still saves the lesson (without a full-text file) when the Drive write fails for one topic", async () => {
    callStructured.mockResolvedValueOnce({
      result: { topics: [topic({ topicNo: 5 })] },
      model: { provider: "anthropic", model: "claude-opus-5-5" },
      costUsd: 0.1,
    });
    saveWorkFullTextToDrive.mockReset().mockRejectedValueOnce(new Error("Google Drive is not connected"));

    const savedRows: Record<string, unknown>[] = [];
    const scope = {
      familyId: "fam1",
      select: (table: string) => {
        if (table === "material_sections") return fluent({ returns: [{ id: "s1", title: "Пригоди і фантастика", page_from: 36, page_to: 75, sort_order: 5 }] });
        if (table === "chunks") return fluent({ returns: [{ page: 40, text: "Даніель Дефо ...", ordinal: 1 }] });
        if (table === "literature_lessons") return fluent({ maybeSingle: null });
        return fluent({ returns: [] });
      },
      client: {
        from: (table: string) => {
          if (table === "topics") return { insert: () => ({ select: () => fluent({ single: { id: "topic-x" } }) }) };
          if (table === "literature_lessons") {
            return {
              upsert: (row: Record<string, unknown>) => {
                savedRows.push(row);
                return { select: () => fluent({ single: { id: "lesson-5" } }) };
              },
            };
          }
          if (table === "literature_lesson_tests") return { upsert: () => Promise.resolve({ error: null }) };
          throw new Error(`unexpected table ${table}`);
        },
      },
    };

    const result = await runLiteratureExtraction(scope as never, {
      familyId: "fam1",
      subjectId: "subj1",
      materialId: "mat1",
      materialTitle: "Зарубіжна література 6 клас",
      subjectName: "Зарубіжна література",
      grade: 6,
    });

    expect(result.driveWriteFailures).toEqual([{ topicNo: 5, reason: "Google Drive is not connected" }]);
    expect(result.topics).toHaveLength(1); // the lesson is still saved
    expect(savedRows[0]).toMatchObject({ work_full_text_drive_file_id: null });
  });
});
