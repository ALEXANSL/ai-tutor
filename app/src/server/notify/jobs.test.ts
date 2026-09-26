import { describe, expect, it, vi, beforeEach } from "vitest";
import type { JobRow } from "@/server/jobs/runner";

/**
 * QA-added coverage (this run finds this file had ZERO prior tests despite
 * being the whole point of ADR-010/US-11.7): channel independence (a Resend
 * failure must never block the Telegram job or vice versa — КП-3), the
 * "give up after 3 attempts -> external_delivery_failed" notification with
 * the right channel label, and the 10-minute unread reminder (КП-7) actually
 * skipping when the cabinet notification was already read, and covering
 * both channels when it fires.
 */

const updates: { table: string; values: Record<string, unknown>; id: string }[] = [];
const notifRow = { value: null as { id: string; read_at: string | null } | null };

function makeDb() {
  return {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              updates.push({ table, values, id });
              return Promise.resolve({ error: null });
            },
          };
        },
        select() {
          const self = {
            eq: () => self,
            contains: () => self,
            maybeSingle: () => Promise.resolve({ data: notifRow.value, error: null }),
          };
          return self;
        },
      };
    },
  };
}

vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => makeDb() }));

const notifyParent = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/notifications", () => ({ notifyParent: (...a: unknown[]) => notifyParent(...a) }));

const sendUrgentEmail = vi.fn();
vi.mock("./email", () => ({ sendUrgentEmail: (...a: unknown[]) => sendUrgentEmail(...a) }));

const getLinkedChatId = vi.fn();
const sendTelegramMessage = vi.fn();
vi.mock("./telegram", () => ({
  getLinkedChatId: (...a: unknown[]) => getLinkedChatId(...a),
  sendTelegramMessage: (...a: unknown[]) => sendTelegramMessage(...a),
}));

// `registerJobHandler` stores handlers in a module-private Map inside the
// (unmocked) real runner — replace just that one export so this test can
// call the exact handler functions `registerNotifyJobs` wires up, without
// re-implementing `runJobs`'s claim/retry loop (that's `jobs.test.ts`'s job,
// already covered — backoff only).
interface Handler {
  run(job: JobRow): Promise<unknown>;
  onGiveUp?(job: JobRow, error: unknown): Promise<void>;
  isRetryable?(error: unknown): boolean;
}
const registered = new Map<string, Handler>();
vi.mock("@/server/jobs/runner", async () => {
  const actual = await vi.importActual<typeof import("@/server/jobs/runner")>("@/server/jobs/runner");
  return { ...actual, registerJobHandler: (type: string, handler: Handler) => registered.set(type, handler) };
});

const { registerNotifyJobs } = await import("./jobs");

function job(payload: Record<string, unknown>): JobRow {
  return { id: "job1", family_id: "fam1", type: "x", payload, attempts: 1, max_attempts: 3 };
}

beforeEach(() => {
  updates.length = 0;
  notifRow.value = null;
  notifyParent.mockClear();
  sendUrgentEmail.mockReset();
  getLinkedChatId.mockReset();
  sendTelegramMessage.mockReset();
  registered.clear();
  registerNotifyJobs();
});

describe("notify.deliver_urgent (ADR-010 КП-3: channel independence)", () => {
  it("email success marks the delivery 'sent' and never touches Telegram", async () => {
    sendUrgentEmail.mockResolvedValue({ ok: true });
    await registered.get("notify.deliver_urgent")!.run(job({ deliveryId: "d1", channel: "email", message: "m" }));
    expect(updates).toEqual([{ table: "outbound_deliveries", values: expect.objectContaining({ status: "sent" }), id: "d1" }]);
    expect(getLinkedChatId).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("a Telegram failure (channel down) throws for its own job, independent of email's own job outcome", async () => {
    getLinkedChatId.mockResolvedValue("12345");
    sendTelegramMessage.mockResolvedValue({ ok: false, error: { status: 500, message: "telegram down" } });
    await expect(registered.get("notify.deliver_urgent")!.run(job({ deliveryId: "d2", channel: "telegram", message: "m" }))).rejects.toThrow(
      "telegram down",
    );
    expect(updates).toEqual([{ table: "outbound_deliveries", values: expect.objectContaining({ status: "failed" }), id: "d2" }]);
    expect(sendUrgentEmail).not.toHaveBeenCalled(); // this job instance only ever handles ONE channel — confirms per-channel isolation.
  });

  it("no Telegram linked -> fails that channel's job without ever calling the Bot API", async () => {
    getLinkedChatId.mockResolvedValue(null);
    await expect(registered.get("notify.deliver_urgent")!.run(job({ deliveryId: "d3", channel: "telegram", message: "m" }))).rejects.toThrow();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("onGiveUp (attempts exhausted) notifies the parent with the correct channel label, per channel", async () => {
    await registered.get("notify.deliver_urgent")!.onGiveUp!(job({ channel: "email" }), new Error("x"));
    expect(notifyParent).toHaveBeenCalledWith("fam1", expect.objectContaining({ type: "external_delivery_failed", payload: { channel: "e-mail" } }));
    notifyParent.mockClear();
    await registered.get("notify.deliver_urgent")!.onGiveUp!(job({ channel: "telegram" }), new Error("x"));
    expect(notifyParent).toHaveBeenCalledWith("fam1", expect.objectContaining({ payload: { channel: "Telegram" } }));
  });
});

describe("notify.remind_unread (Should, PM-14, КП-7)", () => {
  it("skips silently when the cabinet notification was already read", async () => {
    notifRow.value = { id: "n1", read_at: "2026-10-01T10:05:00Z" };
    await registered.get("notify.remind_unread")!.run(job({ safetyEventId: "e1", message: "m" }));
    expect(sendUrgentEmail).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips when the notification row cannot be found at all (defensive, never throws)", async () => {
    notifRow.value = null;
    await expect(registered.get("notify.remind_unread")!.run(job({ safetyEventId: "e1", message: "m" }))).resolves.toBeUndefined();
    expect(sendUrgentEmail).not.toHaveBeenCalled();
  });

  it("still unread after 10 min -> resends on BOTH channels (independently of each other)", async () => {
    notifRow.value = { id: "n1", read_at: null };
    getLinkedChatId.mockResolvedValue("12345");
    sendUrgentEmail.mockResolvedValue({ ok: true });
    sendTelegramMessage.mockResolvedValue({ ok: true });
    await registered.get("notify.remind_unread")!.run(job({ safetyEventId: "e1", message: "m" }));
    expect(sendUrgentEmail).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).toHaveBeenCalledWith("12345", "m");
  });

  it("still unread, Telegram not linked -> resends only by e-mail, does not throw", async () => {
    notifRow.value = { id: "n1", read_at: null };
    getLinkedChatId.mockResolvedValue(null);
    sendUrgentEmail.mockResolvedValue({ ok: true });
    await expect(registered.get("notify.remind_unread")!.run(job({ safetyEventId: "e1", message: "m" }))).resolves.toBeUndefined();
    expect(sendUrgentEmail).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
