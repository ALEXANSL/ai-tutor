import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D-112 audit fix: `getBulkWarmupStatusAction` (US-22.4 КП-5) is polled by
 * `BulkWarmupPanel` to refresh status badges after the parent confirms a bulk
 * warm-up (`confirmBulkWarmupAction`, which enqueues with `immediate: false`
 * on purpose). Since `pg_cron` is NOT actually configured in production
 * (ADR-015 §Примітка), this polling loop was the panel's only remaining
 * chance to nudge the job queue forward — same pattern as `pollIndexingAction`
 * in books.ts. This file did not even import `kickJobs` before the fix.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/auth/guards", () => ({
  requireParentAccess: () => Promise.resolve({ familyId: "fam1", ctx: { appUserId: "user1" } }),
}));

vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({}) }));

const kickJobs = vi.fn();
vi.mock("@/server/jobs/kick", () => ({ kickJobs: (...a: unknown[]) => kickJobs(...a) }));

const getTopicWarmupStatuses = vi.fn();
vi.mock("@/server/lessons/warmup", () => ({
  ensureActiveLibraryBlock: vi.fn(),
  estimateBulkWarmup: vi.fn(),
  getTopicWarmupStatuses: (...a: unknown[]) => getTopicWarmupStatuses(...a),
  warmAheadForSubject: vi.fn(),
}));

vi.mock("@/server/subjects/queries", () => ({ getSubjectForBulkWarmup: vi.fn() }));

const { getBulkWarmupStatusAction } = await import("./subjects");

const TOPIC_1 = "11111111-1111-1111-1111-111111111111";
const TOPIC_2 = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  kickJobs.mockClear();
  getTopicWarmupStatuses.mockReset();
});

describe("getBulkWarmupStatusAction (D-112: must kick the job queue like pollIndexingAction does)", () => {
  it("some topics still queued/generating -> kicks the queue", async () => {
    getTopicWarmupStatuses.mockResolvedValue({ [TOPIC_1]: "ready", [TOPIC_2]: "queued" });
    const result = await getBulkWarmupStatusAction([TOPIC_1, TOPIC_2]);
    expect(result).toEqual({ status: "ok", statuses: { [TOPIC_1]: "ready", [TOPIC_2]: "queued" } });
    expect(kickJobs).toHaveBeenCalledTimes(1);
  });

  it("a topic is generating -> kicks the queue", async () => {
    getTopicWarmupStatuses.mockResolvedValue({ [TOPIC_1]: "generating" });
    await getBulkWarmupStatusAction([TOPIC_1]);
    expect(kickJobs).toHaveBeenCalledTimes(1);
  });

  it("all topics already resolved (ready/error) -> does NOT kick the queue", async () => {
    getTopicWarmupStatuses.mockResolvedValue({ [TOPIC_1]: "ready", [TOPIC_2]: "error" });
    const result = await getBulkWarmupStatusAction([TOPIC_1, TOPIC_2]);
    expect(result).toEqual({ status: "ok", statuses: { [TOPIC_1]: "ready", [TOPIC_2]: "error" } });
    expect(kickJobs).not.toHaveBeenCalled();
  });
});
