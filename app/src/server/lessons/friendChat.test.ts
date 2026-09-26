import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA-added: `askFriendChat` had zero tests. The one thing worth a dedicated
 * regression test is the deterministic "urgent" override (NFR-SAFE-4,
 * US-12.1 КП-2) — contrast with `orchestrator.test.ts`'s BUG-013 finding,
 * where the equivalent override is MISSING for lesson open answers.
 */
const messagesTable: { author: string; content: string; chat_id?: string }[] = [];
function chain(result: unknown) {
  const self = {
    eq: () => self,
    order: () => self,
    limit: () => self,
    maybeSingle: () => Promise.resolve({ data: result }),
    returns: () => Promise.resolve({ data: result }),
  };
  return self;
}
const scope = {
  select: (table: string) => (table === "chats" ? chain({ id: "chat1" }) : chain([])),
  client: {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table === "messages") messagesTable.push(row as never);
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: "msg1", created_at: "2026-10-01T00:00:00Z" }, error: null }) }),
        };
      },
    }),
  },
};
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => scope }));

const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...a: unknown[]) => callStructured(...a) }));

const moderateMessage = vi.fn();
vi.mock("@/server/safety/moderate", () => ({ moderateMessage: (...a: unknown[]) => moderateMessage(...a) }));

const recordSafetyEvent = vi.fn().mockResolvedValue({ flagged: true, urgent: true, eventId: "e1" });
vi.mock("@/server/safety/events", () => ({ recordSafetyEvent: (...a: unknown[]) => recordSafetyEvent(...a) }));

const { askFriendChat } = await import("./friendChat");

beforeEach(() => {
  messagesTable.length = 0;
  callStructured.mockReset();
  moderateMessage.mockReset();
  recordSafetyEvent.mockClear();
});

describe("askFriendChat + urgent moderation (NFR-SAFE-4)", () => {
  it("urgent severity ALWAYS replaces the model's own reply with the deterministic go-to-dad sentence", async () => {
    moderateMessage.mockResolvedValue({ category: "self_harm", severity: "urgent", confidence: 0.95, layer1Flagged: true, escalated: false, reasonUk: "x" });
    callStructured.mockResolvedValue({ result: { answerUk: "Модель могла б сказати щось зовсім інше тут" }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askFriendChat("fam1", "child1", "Зірочка", "Ліра", "f", "мені дуже погано, я хочу собі зашкодити");

    expect(reply.content).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
    expect(reply.content).not.toContain("Модель могла б сказати");
  });

  it("non-urgent -> the model's own reply is used as-is", async () => {
    moderateMessage.mockResolvedValue({ category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" });
    callStructured.mockResolvedValue({ result: { answerUk: "Драконі теж люблять космос!" }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askFriendChat("fam1", "child1", "Зірочка", "Ліра", "f", "мені подобаються дракони");

    expect(reply.content).toBe("Драконі теж люблять космос!");
  });
});
