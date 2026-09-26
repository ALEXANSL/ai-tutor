import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA-added: `askTopicChat` had zero tests, same finding as `friendChat.ts`.
 * Confirms the same "urgent -> deterministic go-to-dad reply" override IS
 * present here too (contrast: `orchestrator.test.ts`'s BUG-013, where the
 * lesson open-answer path is missing the equivalent override).
 */
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
    from: () => ({
      select: () => chain([]),
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: "msg1", created_at: "2026-10-01T00:00:00Z" }, error: null }) }),
      }),
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

const { askTopicChat } = await import("./chat");

beforeEach(() => {
  callStructured.mockReset();
  moderateMessage.mockReset();
  recordSafetyEvent.mockClear();
});

describe("askTopicChat + urgent moderation (NFR-SAFE-4)", () => {
  it("urgent severity ALWAYS replaces the model's own reply with the deterministic go-to-dad sentence", async () => {
    moderateMessage.mockResolvedValue({ category: "stranger_contact", severity: "urgent", confidence: 0.9, layer1Flagged: true, escalated: false, reasonUk: "x" });
    callStructured.mockResolvedValue({ result: { answerUk: "Ось відповідь про дроби" }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askTopicChat(
      "fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби",
      "у грі якийсь дорослий просить моє фото і адресу",
    );

    expect(reply.content).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
  });

  it("non-urgent -> the model's own grounded reply is used as-is", async () => {
    moderateMessage.mockResolvedValue({ category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" });
    callStructured.mockResolvedValue({ result: { answerUk: "Скорочення дробів — це..." }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни ще раз");

    expect(reply.content).toBe("Скорочення дробів — це...");
  });
});
