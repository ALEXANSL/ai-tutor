import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildUrgentMessage } from "./urgent";

const inserted: { table: string; row: Record<string, unknown> }[] = [];
const enqueued: { type: string; payload: Record<string, unknown> }[] = [];
let insertedIdSeq = 0;

function makeDb() {
  return {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserted.push({ table, row });
          return {
            select() {
              return {
                single: () => Promise.resolve({ data: { id: `id${++insertedIdSeq}` }, error: null }),
              };
            },
          };
        },
        select() {
          const self = {
            eq: () => self,
            maybeSingle: () => Promise.resolve({ data: { timezone: "Europe/Kyiv" }, error: null }),
          };
          return self;
        },
      };
    },
  };
}

vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => makeDb() }));
vi.mock("@/server/jobs/runner", () => ({
  enqueueJob: (_familyId: string, type: string, payload: Record<string, unknown>) => {
    enqueued.push({ type, payload });
    return Promise.resolve();
  },
}));

/**
 * US-11.7 КП-2: the external message content is minimal — category, time,
 * mode, a link — and NEVER a quote, nickname, tutor name or e-mail.
 */
describe("buildUrgentMessage", () => {
  it("contains category, time and mode, and never a quote/nickname", () => {
    const msg = buildUrgentMessage("self_harm", "friend_chat", new Date("2026-10-01T10:00:00Z"), false, "Europe/Kyiv");
    expect(msg).toContain("ТЕРМІНОВО");
    expect(msg).toContain("самоушкодження");
    expect(msg).toContain("ШІ-друг");
    expect(msg).not.toMatch(/Зірочка|мама|тато|@/i);
  });

  it("marks a test notification distinctly", () => {
    const msg = buildUrgentMessage("test", "lesson", new Date(), true, "Europe/Kyiv");
    expect(msg).toContain("ТЕСТ");
    expect(msg).not.toContain("ТЕРМІНОВО —");
  });

  it("formats the time in the given time zone, not a hard-coded one (NFR-PLAT-7)", () => {
    const kyiv = buildUrgentMessage("fear", "lesson", new Date("2026-06-01T10:00:00Z"), false, "Europe/Kyiv");
    const other = buildUrgentMessage("fear", "lesson", new Date("2026-06-01T10:00:00Z"), false, "UTC");
    expect(kyiv).not.toBe(other);
  });
});

/**
 * BUG-015 (PO decision 2026-09-28): Telegram linking is broken and every
 * telegram delivery job was a guaranteed failure, so `enqueueUrgentDelivery`
 * must enqueue an `outbound_deliveries` row + job for e-mail only, and must
 * NOT create a telegram row/job — until the linking bug is fixed and the
 * channel list is restored.
 */
describe("enqueueUrgentDelivery (BUG-015: telegram enqueueing paused)", () => {
  beforeEach(() => {
    inserted.length = 0;
    enqueued.length = 0;
    insertedIdSeq = 0;
  });

  it("creates only an 'email' outbound_deliveries row, never 'telegram'", async () => {
    const { enqueueUrgentDelivery } = await import("./urgent");
    await enqueueUrgentDelivery("fam1", "evt1", "lesson", "fear");
    const deliveryRows = inserted.filter((i) => i.table === "outbound_deliveries");
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0]!.row).toMatchObject({ channel: "email" });
    expect(deliveryRows.some((r) => r.row.channel === "telegram")).toBe(false);
  });

  it("enqueues only an email notify.deliver_urgent job, never telegram", async () => {
    const { enqueueUrgentDelivery, JOB_DELIVER } = await import("./urgent");
    await enqueueUrgentDelivery("fam1", "evt1", "lesson", "fear");
    const deliverJobs = enqueued.filter((e) => e.type === JOB_DELIVER);
    expect(deliverJobs).toHaveLength(1);
    expect(deliverJobs[0]!.payload).toMatchObject({ channel: "email" });
  });
});
