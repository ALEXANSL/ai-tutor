import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetBlockedError, ProviderError } from "@/server/ai/types";

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
const insert = vi.fn(() => ({
  select: () => ({ single: () => Promise.resolve({ data: { id: "msg1", created_at: "2026-10-01T00:00:00Z" }, error: null }) }),
}));
const scope = {
  select: (table: string) => (table === "chats" ? chain({ id: "chat1" }) : chain([])),
  client: {
    from: () => ({
      select: () => chain([]),
      insert,
    }),
  },
};
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => scope }));

const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...a: unknown[]) => callStructured(...a) }));
vi.mock("./tutorModel", () => ({ callLessonTutor: (...args: unknown[]) => callStructured("lesson_tutor", ...args) }));

const moderateMessage = vi.fn();
vi.mock("@/server/safety/moderate", () => ({ moderateMessage: (...a: unknown[]) => moderateMessage(...a) }));

const recordSafetyEvent = vi.fn().mockResolvedValue({ flagged: true, urgent: true, eventId: "e1" });
vi.mock("@/server/safety/events", () => ({ recordSafetyEvent: (...a: unknown[]) => recordSafetyEvent(...a) }));

const { askTopicChat, explainStepAgain } = await import("./chat");

beforeEach(() => {
  callStructured.mockReset();
  moderateMessage.mockReset();
  recordSafetyEvent.mockClear();
  insert.mockClear();
});

describe("explainStepAgain failure handling", () => {
  const explain = () => explainStepAgain("fam1", "child1", "Ліра", "f", "subj1", "Математика", "top1", "Рівняння", "Зірочка", "2,17 + x = 3,42");

  it.each([
    [new BudgetBlockedError("hard_stop", "tutor_chat"), "EXPLAIN-BUDGET"],
    [new ProviderError("private provider payload", "anthropic", 400, false), "EXPLAIN-HTTP-400"],
  ])("does not save or return an AI failure as an explanation (%s)", async (error, code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    callStructured.mockRejectedValue(error);
    await expect(explain()).rejects.toThrow(code);
    expect(insert).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider payload");
    log.mockRestore();
  });

  it("still saves a successful explanation verbatim", async () => {
    callStructured.mockResolvedValue({ result: { explanationUk: "Від суми відніми відомий доданок." } });
    expect((await explain()).content).toBe("Від суми відніми відомий доданок.");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ content: "Від суми відніми відомий доданок." }));
  });
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
describe("complete text replies and explicit subject/style", () => {
  const args = ["fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Українська мова", "top1", "Власні та загальні назви"] as const;
  const safe = { category: "none", severity: "none", confidence: 1, layer1Flagged: false, escalated: false, reasonUk: "" };
  it("keeps a whole page and uses a larger text answer contract with task-specific quality instructions", async () => {
    moderateMessage.mockResolvedValue(safe);
    callStructured.mockResolvedValue({ result: { answerUk: "Правило та приклади." } });
    const page = "Розбери цю сторінку. ".repeat(600);
    await askTopicChat(...args, page);
    const [role, request] = callStructured.mock.calls[0]!;
    expect(role).toBe("lesson_tutor"); expect(request.prompt).toContain(page.trim());
    expect(request.system).toContain("Українська мова"); expect(request.system).toContain("Власні та загальні назви");
    expect(request.system).toContain("текстовий навчальний чат"); expect(request.system).toContain("КОЖЕН приклад");
    expect(request.system).toContain("це тато, я тестую");
    expect(request.schema.safeParse({ answerUk: "x".repeat(6000) }).success).toBe(true);
  });
  it("retains a shorter spoken answer contract without forcing it on text", async () => {
    moderateMessage.mockResolvedValue(safe); callStructured.mockResolvedValue({ result: { answerUk: "Коротке пояснення." } });
    await askTopicChat(...args, "Поясни правило", undefined, { voice: true });
    const request = callStructured.mock.calls[0]![1];
    expect(request.system).toContain("РЕЖИМ: голосова розмова");
    expect(request.schema.safeParse({ answerUk: "x".repeat(2000) }).success).toBe(false);
  });
  it("does not save a failed model response as educational content, but urgent safety still overrides failures", async () => {
    moderateMessage.mockResolvedValue(safe); callStructured.mockRejectedValue(new Error("model failed"));
    await expect(askTopicChat(...args, "Склади приклади")).rejects.toThrow("model failed");
    expect(insert).not.toHaveBeenCalledWith(expect.objectContaining({ author: "ai" }));
    moderateMessage.mockResolvedValue({ ...safe, severity: "urgent" });
    expect((await askTopicChat(...args, "Потрібна допомога")).content).toContain("зараз піди й скажи про це тату");
  });
});
