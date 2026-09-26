import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModerationResult } from "./classify";

/**
 * QA-added: `recordSafetyEvent` had zero direct tests despite being the only
 * place that decides whether an urgent verdict actually reaches
 * `enqueueUrgentDelivery` (-> e-mail/Telegram, ADR-010). Only exercised
 * indirectly through chat.ts/friendChat.ts/orchestrator.ts, none of which
 * had a test for this wiring either.
 */
const insert = vi.fn();
const scopeClient = {
  from: () => ({
    insert: (row: Record<string, unknown>) => {
      insert(row);
      return { select: () => ({ single: () => Promise.resolve({ data: { id: "event1" }, error: null }) }) };
    },
  }),
};
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ client: scopeClient }) }));

const notifyParent = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/notifications", () => ({ notifyParent: (...a: unknown[]) => notifyParent(...a) }));

const kickJobs = vi.fn();
vi.mock("@/server/jobs/kick", () => ({ kickJobs: (...a: unknown[]) => kickJobs(...a) }));

const enqueueUrgentDelivery = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/notify/urgent", () => ({ enqueueUrgentDelivery: (...a: unknown[]) => enqueueUrgentDelivery(...a) }));

const { recordSafetyEvent } = await import("./events");

function verdict(over: Partial<ModerationResult>): ModerationResult {
  return { category: "none", severity: "none", confidence: 1, reasonUk: "", layer1Flagged: false, escalated: false, layersUnavailable: false, ...over };
}

beforeEach(() => {
  insert.mockClear();
  notifyParent.mockClear();
  kickJobs.mockClear();
  enqueueUrgentDelivery.mockClear();
});

describe("recordSafetyEvent (ADR-009, US-11.6/11.7)", () => {
  it("category=none -> no row inserted, no cabinet notification, no external delivery", async () => {
    const r = await recordSafetyEvent("fam1", "child1", "lesson", "як розв'язати 2+2?", verdict({}));
    expect(r).toEqual({ flagged: false, urgent: false, eventId: null });
    expect(insert).not.toHaveBeenCalled();
    expect(notifyParent).not.toHaveBeenCalled();
    expect(enqueueUrgentDelivery).not.toHaveBeenCalled();
  });

  it("residual-risk fix: both moderation layers unavailable -> no safety_events row (can't classify), but the parent IS still notified", async () => {
    const r = await recordSafetyEvent(
      "fam1", "child1", "friend_chat", "я хочу собі зашкодити",
      verdict({ layersUnavailable: true }),
    );
    expect(r).toEqual({ flagged: false, urgent: false, eventId: null });
    expect(insert).not.toHaveBeenCalled();
    expect(notifyParent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "safety_moderation_unavailable", severity: "urgent", payload: expect.objectContaining({ mode: "friend_chat" }) }),
    );
    expect(enqueueUrgentDelivery).not.toHaveBeenCalled();
  });

  it("flagged but severity=normal -> cabinet notification only, NEVER external delivery (only 'urgent' escalates outside the cabinet)", async () => {
    const r = await recordSafetyEvent("fam1", "child1", "friend_chat", "мені трохи сумно", verdict({ category: "sadness", severity: "normal" }));
    expect(r).toEqual({ flagged: true, urgent: false, eventId: "event1" });
    expect(notifyParent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "safety_alert", severity: "normal", payload: expect.objectContaining({ category: "sadness" }) }),
    );
    expect(enqueueUrgentDelivery).not.toHaveBeenCalled();
    expect(kickJobs).not.toHaveBeenCalled();
  });

  it("severity=urgent -> the quote IS stored in safety_events, but enqueueUrgentDelivery/kickJobs fire and the cabinet event carries no quote", async () => {
    const r = await recordSafetyEvent("fam1", "child1", "friend_chat", "я хочу собі зашкодити", verdict({ category: "self_harm", severity: "urgent", confidence: 0.95 }));
    expect(r).toEqual({ flagged: true, urgent: true, eventId: "event1" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ quote: "я хочу собі зашкодити", category: "self_harm", severity: "urgent" }));
    // The cabinet notification payload (unlike the DB row) never repeats the quote.
    const cabinetPayload = notifyParent.mock.calls[0]![1].payload as Record<string, unknown>;
    expect(cabinetPayload).not.toHaveProperty("quote");
    expect(enqueueUrgentDelivery).toHaveBeenCalledWith("fam1", "event1", "friend_chat", "self_harm");
    expect(kickJobs).toHaveBeenCalledTimes(1);
  });

  it("never throws even if notifyParent/enqueueUrgentDelivery reject (a notification bug must not break the reply)", async () => {
    notifyParent.mockRejectedValueOnce(new Error("down"));
    enqueueUrgentDelivery.mockRejectedValueOnce(new Error("down"));
    await expect(
      recordSafetyEvent("fam1", "child1", "lesson", "х", verdict({ category: "dangerous_act", severity: "urgent" })),
    ).resolves.toMatchObject({ urgent: true });
  });
});
