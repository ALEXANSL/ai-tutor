import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * US-23.1 КП-4/КП-5 (E-23): `askMaterialChat` is a sibling to `askTopicChat`
 * (chat.test.ts), scoped by `material_id` instead of `topic_id` — same
 * safety guarantees (NFR-SAFE-4): the urgent-severity override is checked
 * exactly like `chat.test.ts`/`friendChat.test.ts`, plus this module's own
 * concern — that the fragments query is scoped to THIS material only
 * (КП-4: "без домішування фрагментів інших книг чи підручників").
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

const chunksEqCalls: unknown[][] = [];

const scope = {
  select: (table: string) => {
    if (table === "chats") return chain({ id: "chat1" });
    if (table === "chunks") {
      const self = {
        eq: (...a: unknown[]) => {
          chunksEqCalls.push(a);
          return self;
        },
        order: () => self,
        limit: () => self,
        returns: () => Promise.resolve({ data: [{ page: 3, text: "Фрагмент саме цієї книги" }] }),
      };
      return self;
    }
    return chain([]);
  },
  client: {
    from: () => ({
      select: () => chain([]),
      insert: () => ({
        select: () => ({ single: () => Promise.resolve({ data: { id: "msg1", created_at: "2026-10-08T00:00:00Z" }, error: null }) }),
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

const { askMaterialChat } = await import("./materialChat");

beforeEach(() => {
  chunksEqCalls.length = 0;
  callStructured.mockReset();
  moderateMessage.mockReset();
  recordSafetyEvent.mockClear();
});

describe("askMaterialChat + urgent moderation (NFR-SAFE-4, US-23.1 КП-5 — no relaxation)", () => {
  it("urgent severity ALWAYS replaces the model's own reply with the deterministic go-to-dad sentence", async () => {
    moderateMessage.mockResolvedValue({ category: "stranger_contact", severity: "urgent", confidence: 0.9, layer1Flagged: true, escalated: false, reasonUk: "x" });
    callStructured.mockResolvedValue({ result: { answerUk: "Модель могла б сказати щось зовсім інше" }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askMaterialChat("fam1", "child1", "Зірочка", "Ліра", "f", "mat1", "Клуб «Прототипи»", "у грі якийсь дорослий просить моє фото і адресу");

    expect(reply.content).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
    expect(reply.content).not.toContain("Модель могла б сказати");
  });

  it("non-urgent -> the model's own grounded reply is used as-is", async () => {
    moderateMessage.mockResolvedValue({ category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" });
    callStructured.mockResolvedValue({ result: { answerUk: "У цій книзі йдеться про..." }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askMaterialChat("fam1", "child1", "Зірочка", "Ліра", "f", "mat1", "Клуб «Прототипи»", "про що ця книга?");

    expect(reply.content).toBe("У цій книзі йдеться про...");
  });

  it("КП-4: the chunks query is scoped to this material_id only, never a topic", async () => {
    moderateMessage.mockResolvedValue({ category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" });
    callStructured.mockResolvedValue({ result: { answerUk: "..." }, model: {}, costUsd: 0, fallbackUsed: false });

    await askMaterialChat("fam1", "child1", "Зірочка", "Ліра", "f", "mat1", "Клуб «Прототипи»", "питання");

    expect(chunksEqCalls).toContainEqual(["material_id", "mat1"]);
  });
});
