import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ auth: vi.fn(), kick: vi.fn(), warm: vi.fn(), estimate: vi.fn(), statuses: vi.fn(), ahead: vi.fn(), rpc: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: mock.auth }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ client: { rpc: mock.rpc } }) }));
vi.mock("@/server/jobs/kick", () => ({ kickJobs: mock.kick }));
vi.mock("@/server/lessons/warmup", () => ({ ensureActiveLibraryBlock: mock.warm, estimateBulkWarmup: mock.estimate, getTopicWarmupStatuses: mock.statuses, warmAheadForSubject: mock.ahead }));
import { estimateBulkWarmupAction, confirmBulkWarmupAction, getBulkWarmupStatusAction, setCurrentTopicAction } from "./subjects";
const SUBJECT = "11111111-1111-4111-8111-111111111111", TOPIC = "22222222-2222-4222-8222-222222222222";
beforeEach(() => { vi.clearAllMocks(); mock.auth.mockResolvedValue({ familyId: "family" }); mock.rpc.mockResolvedValue({ error: null }); });
describe("retired bulk preparation", () => {
  it("old tabs cannot estimate, enqueue or kick the AI generation queue", async () => {
    expect(await estimateBulkWarmupAction(SUBJECT, [TOPIC])).toMatchObject({ status: "error" });
    expect(await confirmBulkWarmupAction(SUBJECT, [TOPIC])).toMatchObject({ status: "error" });
    expect(await getBulkWarmupStatusAction([TOPIC])).toMatchObject({ status: "error" });
    for (const fn of [mock.estimate, mock.warm, mock.kick, mock.statuses]) expect(fn).not.toHaveBeenCalled();
  });
  it("still requires a parent before responding to stale requests", async () => {
    mock.auth.mockRejectedValue(new Error("parent required"));
    await expect(confirmBulkWarmupAction(SUBJECT, [TOPIC])).rejects.toThrow(); expect(mock.warm).not.toHaveBeenCalled();
  });
  it("marking a legacy current topic no longer starts hidden warm-ahead", async () => {
    const data = new FormData(); data.set("subjectId", SUBJECT); data.set("topicId", TOPIC);
    expect(await setCurrentTopicAction({ status: "idle" }, data)).toMatchObject({ status: "ok" });
    expect(mock.rpc).toHaveBeenCalledWith("set_current_topic", { p_family_id: "family", p_subject_id: SUBJECT, p_topic_id: TOPIC });
    expect(mock.ahead).not.toHaveBeenCalled(); expect(mock.kick).not.toHaveBeenCalled();
  });
});
