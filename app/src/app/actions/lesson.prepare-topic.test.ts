import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * US-19.5 КП-2 (S38, D-114): `prepareTopicAction` — the child's own
 * "Підготувати" tap. Covers the two things this slice's approval hinges on:
 *  - it calls `ensureActiveLibraryBlock` tagged `source: "child_initiated"`;
 *  - it does NOT pass `bypassDailyBudget` — ВП-66 confirmed this should
 *    count toward the existing daily $5 family warm-up budget cap like any
 *    other warm-up call, no separate uncapped path.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/auth/guards", () => ({
  requireChild: () => Promise.resolve({ ctx: { familyId: "fam1", appUserId: "user1" }, profile: { id: "child1" } }),
}));

vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({}) }));
vi.mock("@/server/jobs/kick", () => ({ kickJobs: vi.fn() }));
vi.mock("@/server/lessons/chat", () => ({ askTopicChat: vi.fn(), explainStepAgain: vi.fn() }));
vi.mock("@/server/lessons/generate", () => ({ recordChildFeedback: vi.fn() }));
vi.mock("@/server/lessons/narration", () => ({ readableTextForStep: vi.fn(), synthesizeStepNarration: vi.fn() }));
vi.mock("@/server/lessons/orchestrator", () => ({
  acknowledgeSlide: vi.fn(),
  checkWarmupProgress: vi.fn(),
  chooseStartBlock: vi.fn(),
  continueAfterBlock: vi.fn(),
  getPreviousModuleView: vi.fn(),
  goToPreviousStep: vi.fn(),
  pauseLessonSession: vi.fn(),
  resumeLessonSession: vi.fn(),
  setPresentationMode: vi.fn(),
  skipLessonBreak: vi.fn(),
  startLessonSession: vi.fn(),
  submitStepAnswer: vi.fn(),
  takeLessonBreak: vi.fn(),
  tickLessonActivity: vi.fn(),
}));

const getSubjectForBulkWarmup = vi.fn();
vi.mock("@/server/subjects/queries", () => ({ getSubjectForBulkWarmup: (...a: unknown[]) => getSubjectForBulkWarmup(...a) }));

const ensureActiveLibraryBlock = vi.fn();
vi.mock("@/server/lessons/warmup", () => ({ ensureActiveLibraryBlock: (...a: unknown[]) => ensureActiveLibraryBlock(...a) }));

const { prepareTopicAction } = await import("./lesson");

const SUBJECT_ID = "11111111-1111-4111-8111-111111111111";
const TOPIC_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  getSubjectForBulkWarmup.mockReset();
  ensureActiveLibraryBlock.mockReset();
});

describe("prepareTopicAction", () => {
  it("enqueues via ensureActiveLibraryBlock tagged child_initiated, WITHOUT bypassing the daily budget", async () => {
    getSubjectForBulkWarmup.mockResolvedValue({
      id: SUBJECT_ID,
      nameUk: "Математика",
      config: {},
      topics: [{ id: TOPIC_ID, title: "Дроби", grade: 6 }],
    });
    ensureActiveLibraryBlock.mockResolvedValue({ status: "job_pending", jobId: "job1" });

    const result = await prepareTopicAction(SUBJECT_ID, TOPIC_ID);

    expect(result).toEqual({ status: "ok", warmStatus: "job_pending" });
    expect(ensureActiveLibraryBlock).toHaveBeenCalledTimes(1);
    const [familyId, subjectMeta, topicMeta, opts] = ensureActiveLibraryBlock.mock.calls[0]!;
    expect(familyId).toBe("fam1");
    expect(subjectMeta).toEqual({ id: SUBJECT_ID, nameUk: "Математика", config: {} });
    expect(topicMeta).toEqual({ id: TOPIC_ID, title: "Дроби", grade: 6 });
    expect(opts.source).toBe("child_initiated");
    expect(opts.bypassDailyBudget).toBeUndefined(); // must count toward the daily cap like "auto" (ВП-66)
    expect(opts.immediate).toBe(false);
  });

  it("returns ok even when the daily budget defers the job (fails open to the badge/status model, not an error)", async () => {
    getSubjectForBulkWarmup.mockResolvedValue({
      id: SUBJECT_ID,
      nameUk: "Математика",
      config: {},
      topics: [{ id: TOPIC_ID, title: "Дроби", grade: 6 }],
    });
    ensureActiveLibraryBlock.mockResolvedValue({ status: "deferred_daily_budget" });

    const result = await prepareTopicAction(SUBJECT_ID, TOPIC_ID);
    expect(result).toEqual({ status: "ok", warmStatus: "deferred_daily_budget" });
  });

  it("errors without calling ensureActiveLibraryBlock when the topic does not belong to the subject/family", async () => {
    getSubjectForBulkWarmup.mockResolvedValue({ id: SUBJECT_ID, nameUk: "Математика", config: {}, topics: [] });

    const result = await prepareTopicAction(SUBJECT_ID, TOPIC_ID);
    expect(result.status).toBe("error");
    expect(ensureActiveLibraryBlock).not.toHaveBeenCalled();
  });
});
