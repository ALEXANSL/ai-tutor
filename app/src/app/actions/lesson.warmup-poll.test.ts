import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-112 audit fix: `checkWarmupProgressAction` is polled every few seconds by
 * `LibraryWarmProgress` while a child waits for a "cold" topic to warm up.
 * Since `pg_cron` is NOT actually configured in production (ADR-015 §Примітка),
 * client polling nudging the queue (`kickJobs()`) is the only thing that
 * reliably moves the job forward outside of the request that first enqueued
 * it — same pattern as `pollIndexingAction` (books.ts). Without this, a job
 * left `queued`/`running` after its first `kickJobs()` budget runs out just
 * sits there forever while the child stares at "Готуємо урок…".
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/auth/guards", () => ({
  requireLessonAccess: () => Promise.resolve({ familyId: "fam1", ctx: { appUserId: "user1" } }),
}));

vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({}) }));

const kickJobs = vi.fn();
vi.mock("@/server/jobs/kick", () => ({ kickJobs: (...a: unknown[]) => kickJobs(...a) }));

vi.mock("@/server/lessons/chat", () => ({ askTopicChat: vi.fn(), explainStepAgain: vi.fn() }));
vi.mock("@/server/lessons/generate", () => ({ recordChildFeedback: vi.fn() }));
vi.mock("@/server/lessons/narration", () => ({ readableTextForStep: vi.fn(), synthesizeStepNarration: vi.fn() }));

const checkWarmupProgress = vi.fn();
vi.mock("@/server/lessons/orchestrator", () => ({
  acknowledgeSlide: vi.fn(),
  checkWarmupProgress: (...a: unknown[]) => checkWarmupProgress(...a),
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

const { checkWarmupProgressAction } = await import("./lesson");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  kickJobs.mockClear();
  checkWarmupProgress.mockReset();
});

describe("checkWarmupProgressAction (D-112: must kick the job queue like pollIndexingAction does)", () => {
  it("ready: false -> kicks the queue (the job may otherwise just sit there with no pg_cron)", async () => {
    checkWarmupProgress.mockResolvedValue({ ready: false, stage: "generation", reviewPass: 1 });
    const result = await checkWarmupProgressAction(SESSION_ID);
    expect(result).toEqual({ status: "ok", ready: false, stage: "generation", reviewPass: 1 });
    expect(kickJobs).toHaveBeenCalledTimes(1);
  });

  it("ready: true -> does NOT kick the queue (nothing left to nudge)", async () => {
    checkWarmupProgress.mockResolvedValue({ ready: true, stage: null, reviewPass: null });
    const result = await checkWarmupProgressAction(SESSION_ID);
    expect(result).toEqual({ status: "ok", ready: true, stage: null, reviewPass: null });
    expect(kickJobs).not.toHaveBeenCalled();
  });
});
