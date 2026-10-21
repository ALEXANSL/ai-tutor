import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  queries: [] as { table: string; columns: string; filters: [string, unknown][] }[],
  inserts: [] as { family_id: string; chat_id: string; author: string; type: string; content: string }[],
  rejectHomework: true,
  failTranscript: false,
}));

vi.mock("@/server/db/family-scope", () => {
  function select(table: string, columns: string) {
    if (/keys|solutions|step_attempts/.test(table)) throw new Error("private data or grading must not be queried");
    const query = { table, columns, filters: [] as [string, unknown][] };
    fixture.queries.push(query);
    const self = {
      eq: (column: string, value: unknown) => { query.filters.push([column, value]); return self; },
      order: () => self,
      limit: () => self,
      maybeSingle: async () => {
        if (table === "messages" && columns.includes("meta") && fixture.rejectHomework) {
          throw new Error("current-step voice must not enter a stale homework cycle");
        }
        return { data: table === "chats" ? { id: "chat1" } : null, error: null };
      },
      returns: async () => ({ data: [], error: null }),
    };
    return self;
  }
  const client = {
    from: (table: string) => ({
      select: (columns: string) => select(table, columns),
      insert: (row: (typeof fixture.inserts)[number]) => {
        fixture.inserts.push(row);
        return {
          error: fixture.failTranscript && row.author === "child" ? { message: "storage unavailable" } : null,
          select: () => ({ single: async () => ({ data: { id: "msg1", created_at: "2026-10-21T00:00:00Z" }, error: null }) }),
        };
      },
    }),
  };
  return { forFamily: () => ({ select, client }) };
});

const calls = vi.hoisted(() => ({ structured: vi.fn(), moderate: vi.fn(), safetyEvent: vi.fn() }));
vi.mock("@/server/ai/router", () => ({ callStructured: calls.structured }));
vi.mock("@/server/safety/moderate", () => ({ moderateMessage: calls.moderate }));
vi.mock("@/server/safety/events", () => ({ recordSafetyEvent: calls.safetyEvent }));

const { askTopicChat } = await import("./chat");
const context = "Додавання дробів. Вправа №117: знайди спільний знаменник для однієї другої та однієї третьої.";
const baseArgs = ["fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби"] as const;

beforeEach(() => {
  fixture.queries.length = 0;
  fixture.inserts.length = 0;
  fixture.rejectHomework = true;
  fixture.failTranscript = false;
  calls.structured.mockReset();
  calls.moderate.mockReset();
  calls.safetyEvent.mockReset();
  calls.structured.mockResolvedValue({ result: { answerUk: "Подумаймо про спільні частини. Яке число ділиться на два і на три?" } });
  calls.moderate.mockResolvedValue({ category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" });
  calls.safetyEvent.mockResolvedValue({ flagged: false, urgent: false, eventId: null });
});

describe("voice clarification stays grounded in the current prepared lesson", () => {
  it("does not generate a voice reply when the child's transcript cannot be saved", async () => {
    fixture.failTranscript = true;
    await expect(askTopicChat(...baseArgs, "Поясни, будь ласка", undefined, { voice: true, stepContext: context })).rejects.toThrow("saving voice transcript failed");
    expect(calls.structured).not.toHaveBeenCalled();
  });
  it("uses the current exercise even for a spoken problem number, without entering an older homework/answer-key path", async () => {
    const result = await askTopicChat(...baseArgs, "Поясни вправу №117", undefined, { voice: true, stepContext: context });
    expect(result.content).toContain("спільні частини");
    expect(calls.structured).toHaveBeenCalledTimes(1);
    const [role, request] = calls.structured.mock.calls[0]!;
    expect(role).toBe("tutor_chat");
    expect(request.prompt).toContain(context);
    expect(request.system).toMatch(/(?:поточн|готов|надан)[\s\S]*(?:урок|крок)/iu);
    expect(request.system).toMatch(/не[\s\S]{0,40}вигад[\s\S]{0,40}сторін/iu);
    expect(fixture.queries.some((q) => q.columns.includes("meta"))).toBe(false);
    expect(fixture.queries.some((q) => q.table === "material_problems")).toBe(false);
    expect(fixture.inserts.map((row) => [row.author, row.type])).toEqual([["child", "voice_transcript"], ["ai", "voice_transcript"]]);
    expect(calls.moderate).toHaveBeenCalledWith(expect.objectContaining({ familyId: "fam1", message: "Поясни вправу №117" }));
  });

  it("keeps the urgent go-to-dad override ahead of any spoken tutoring answer", async () => {
    calls.moderate.mockResolvedValue({ category: "self_harm", severity: "urgent", confidence: 0.99, layer1Flagged: true, escalated: false, reasonUk: "risk" });
    const result = await askTopicChat(...baseArgs, "Я хочу собі нашкодити", undefined, { voice: true, stepContext: context });
    expect(result.content).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
    expect(fixture.inserts.at(-1)?.content).toBe(result.content);
    expect(calls.safetyEvent).toHaveBeenCalledWith("fam1", "child1", "tutor_chat", "Я хочу собі нашкодити", expect.objectContaining({ severity: "urgent" }), expect.objectContaining({ chatId: "chat1" }));
  });

  it("leaves ordinary text topic chat on its existing homework-aware route", async () => {
    fixture.rejectHomework = false;
    await askTopicChat(...baseArgs, "Поясни ще раз");
    expect(fixture.queries.some((q) => q.columns.includes("meta"))).toBe(true);
    expect(fixture.inserts.map((row) => row.type)).toEqual(["text", "text"]);
    const [, request] = calls.structured.mock.calls[0]!;
    expect(request.prompt).not.toContain(context);
    expect(request.system).toContain("спираючись ЛИШЕ на надані фрагменти");
  });
});
