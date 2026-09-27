import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * US-8.7 ("поясни задачу №N", ADR-029 §4 / ADR-028 §3): the exact-lookup and
 * three-call cycle built on top of `askTopicChat`'s existing shape
 * (`chat.test.ts` already covers the plain Q&A path's urgent override — this
 * file is the homework-problem dialog specifically). A small in-memory fake
 * of `forFamily` stands in for Postgres/PostgREST, including the
 * `meta->>key` jsonb-path filter `chat.ts` uses to find a chat's own
 * `homework_problem`-tagged AI messages.
 */

type Row = Record<string, unknown>;
let db: Record<string, Row[]>;

function query(table: string) {
  let rows = [...(db[table] ?? [])];
  let desc = false;
  let limitN: number | null = null;
  const self = {
    eq(col: string, val: unknown) {
      if (col.startsWith("meta->>")) {
        const key = col.slice("meta->>".length);
        rows = rows.filter((r) => ((r.meta as Row | undefined) ?? {})[key] === val);
      } else {
        rows = rows.filter((r) => r[col] === val);
      }
      return self;
    },
    in(col: string, vals: unknown[]) {
      rows = rows.filter((r) => vals.includes(r[col]));
      return self;
    },
    order(_col: string, opts?: { ascending?: boolean }) {
      desc = opts?.ascending === false;
      return self;
    },
    limit(n: number) {
      limitN = n;
      return self;
    },
    async maybeSingle() {
      return { data: finalize()[0] ?? null };
    },
    async returns() {
      return { data: finalize() };
    },
  };
  function finalize() {
    let out = [...rows];
    if (desc) out = out.slice().reverse();
    if (limitN != null) out = out.slice(0, limitN);
    return out;
  }
  return self;
}

let idCounter = 0;
function makeScope() {
  return {
    select(table: string) {
      return query(table);
    },
    client: {
      from(table: string) {
        return {
          select() {
            return query(table);
          },
          insert(row: Row | Row[]) {
            const arr = Array.isArray(row) ? row : [row];
            const withDefaults = arr.map((r) => ({
              id: r.id ?? `gen-${table}-${idCounter++}`,
              created_at: new Date(2026, 0, 1, 0, 0, idCounter).toISOString(),
              meta: {},
              ...r,
            }));
            db[table] = [...(db[table] ?? []), ...withDefaults];
            return {
              select() {
                return { single: async () => ({ data: withDefaults[0], error: null }) };
              },
            };
          },
        };
      },
    },
  };
}

vi.mock("@/server/db/family-scope", () => ({ forFamily: () => makeScope() }));

const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...a: unknown[]) => callStructured(...a) }));

const moderateMessage = vi.fn();
vi.mock("@/server/safety/moderate", () => ({ moderateMessage: (...a: unknown[]) => moderateMessage(...a) }));

const recordSafetyEvent = vi.fn().mockResolvedValue({ flagged: false, urgent: false, eventId: null });
vi.mock("@/server/safety/events", () => ({ recordSafetyEvent: (...a: unknown[]) => recordSafetyEvent(...a) }));

const { askTopicChat, extractProblemRequest, normalizeProblemNumber, resolveProblemRef } = await import("./chat");

const NOT_URGENT = { category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" };
const URGENT = { category: "self_harm", severity: "urgent", confidence: 0.9, layer1Flagged: true, escalated: false, reasonUk: "x" };

function seedChat() {
  db.chats = [{ id: "chat1", child_profile_id: "child1", topic_id: "top1", subject_id: "subj1" }];
}

beforeEach(() => {
  db = {};
  idCounter = 0;
  seedChat();
  callStructured.mockReset();
  moderateMessage.mockReset().mockResolvedValue(NOT_URGENT);
  recordSafetyEvent.mockClear();
});

describe("normalizeProblemNumber", () => {
  it("strips a leading №, trims and caps length", () => {
    expect(normalizeProblemNumber("№117")).toBe("117");
    expect(normalizeProblemNumber("  117  ")).toBe("117");
    expect(normalizeProblemNumber("№ 117а")).toBe("117а");
  });
});

describe("extractProblemRequest (US-8.7 КП-1: only an explicit, literal number)", () => {
  it("recognises common phrasings", () => {
    expect(extractProblemRequest("поясни задачу №117")).toEqual({ number: "117" });
    expect(extractProblemRequest("задача 117 незрозуміла")).toEqual({ number: "117" });
    expect(extractProblemRequest("вправа 5")).toEqual({ number: "5" });
    expect(extractProblemRequest("номер 22")).toEqual({ number: "22" });
  });

  it("also picks up a stated page", () => {
    expect(extractProblemRequest("поясни задачу №117, сторінка 42")).toEqual({ number: "117", page: 42 });
    expect(extractProblemRequest("№117 с. 42")).toEqual({ number: "117", page: 42 });
  });

  it("returns null for an ordinary message with no explicit number (never guesses one)", () => {
    expect(extractProblemRequest("поясни ще раз, будь ласка")).toBeNull();
    expect(extractProblemRequest("у грі якийсь дорослий просить моє фото і адресу")).toBeNull();
  });
});

describe("resolveProblemRef (US-8.7 КП-7: exact match only, never fuzzy)", () => {
  it("finds a single exact match within the chat's own topic", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    const res = await resolveProblemRef("fam1", "top1", "subj1", "117");
    expect(res).toEqual({ kind: "found", ref: { materialId: "m1", materialTitle: "Математика 5", page: 42, topicId: "top1" } });
  });

  it("is ambiguous when the topic scope has more than one exact match", async () => {
    db.material_problems = [
      { material_id: "m1", page: 42, topic_id: "top1", number: "117" },
      { material_id: "m2", page: 10, topic_id: "top1", number: "117" },
    ];
    const res = await resolveProblemRef("fam1", "top1", "subj1", "117");
    expect(res).toEqual({ kind: "ambiguous" });
  });

  it("widens to the whole subject when the topic scope has no match, still exact", async () => {
    db.material_problems = [{ material_id: "m2", page: 8, topic_id: null, number: "117" }];
    db.materials = [{ id: "m2", subject_id: "subj1", title: null, name: "zbirnyk.pdf" }];
    const res = await resolveProblemRef("fam1", "top1", "subj1", "№117");
    expect(res).toEqual({ kind: "found", ref: { materialId: "m2", materialTitle: "zbirnyk.pdf", page: 8, topicId: null } });
  });

  it("is not_found when neither scope has any match (never invents one)", async () => {
    const res = await resolveProblemRef("fam1", "top1", "subj1", "999");
    expect(res).toEqual({ kind: "not_found" });
  });
});

describe("askTopicChat + homework-problem dialog (US-8.7, ADR-029 §4)", () => {
  it("КП-1: an unresolved number never starts the cycle and never writes messages.meta — it just asks for the page", async () => {
    const reply = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");
    expect(reply.content).toMatch(/сторінку/);
    expect(callStructured).not.toHaveBeenCalled();
    const saved = db.messages!.find((m) => m.author === "ai");
    expect(saved!.meta).toEqual({});
  });

  it("КП-1/КП-2: a resolved number gets the method explanation (no solution), tagged with stage 'method'", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    db.chunks = [{ material_id: "m1", page: 42, text: "117. Розв'яжи рівняння 2x + 3 = 7." }];
    callStructured.mockResolvedValueOnce({ result: { methodUk: "Спочатку перенеси число без x в іншу частину рівняння." }, model: {}, costUsd: 0.001 });

    const reply = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");

    expect(reply.content).toBe("Спочатку перенеси число без x в іншу частину рівняння.");
    expect(callStructured.mock.calls[0]![0]).toBe("step_reinforcement");
    expect((callStructured.mock.calls[0]![2] as { ref: { table: string } }).ref.table).toBe("messages");
    const saved = db.messages!.find((m) => m.author === "ai");
    expect(saved!.meta).toMatchObject({ kind: "homework_problem", problemNumber: "117", stage: "method", attemptNo: 0 });
  });

  it("BUG-040: the 'method' call's system prompt carries the safety preamble (never a secret from dad, no name/address, urgent -> go to dad)", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    db.chunks = [{ material_id: "m1", page: 42, text: "117. Розв'яжи рівняння 2x + 3 = 7." }];
    callStructured.mockResolvedValueOnce({ result: { methodUk: "Метод: перенеси доданки." }, model: {}, costUsd: 0 });

    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");

    const system = (callStructured.mock.calls[0]![1] as { system: string }).system;
    expect(system).toMatch(/ПРАВИЛА БЕЗПЕКИ/);
    expect(system).toMatch(/НІКОЛИ не обіцяєш зберегти секрет від тата/);
  });

  it("BUG-040: the 'attempt_feedback' call's system prompt also carries the safety preamble", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    db.chunks = [{ material_id: "m1", page: 42, text: "117. Розв'яжи рівняння 2x + 3 = 7." }];
    callStructured.mockResolvedValueOnce({ result: { methodUk: "Метод: перенеси доданки." }, model: {}, costUsd: 0 });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");

    callStructured.mockResolvedValueOnce({
      result: { messageKind: "attempt", verdict: "incorrect_or_partial", explanationUk: "Не так — перевір знак." },
      model: {},
      costUsd: 0,
    });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "x = 5");

    const system = (callStructured.mock.calls[1]![1] as { system: string }).system;
    expect(system).toMatch(/ПРАВИЛА БЕЗПЕКИ/);
  });

  it("BUG-040: the 'fallback' (full-solution) call's system prompt also carries the safety preamble", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    db.chunks = [{ material_id: "m1", page: 42, text: "117. Розв'яжи рівняння 2x + 3 = 7." }];
    callStructured.mockResolvedValueOnce({ result: { methodUk: "Метод: перенеси доданки." }, model: {}, costUsd: 0 });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");

    callStructured.mockResolvedValueOnce({
      result: { messageKind: "attempt", verdict: "incorrect_or_partial", explanationUk: "Не так." },
      model: {},
      costUsd: 0,
    });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "x = 5");

    callStructured.mockResolvedValueOnce({
      result: { messageKind: "attempt", verdict: "incorrect_or_partial", explanationUk: "Досі не так." },
      model: {},
      costUsd: 0,
    });
    callStructured.mockResolvedValueOnce({ result: { solutionUk: "Повний розв'язок: x = 2." }, model: {}, costUsd: 0 });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "x = 6");

    const fallbackCallIndex = callStructured.mock.calls.length - 1;
    const system = (callStructured.mock.calls[fallbackCallIndex]![1] as { system: string }).system;
    expect(system).toMatch(/ПРАВИЛА БЕЗПЕКИ/);
  });

  it("КП-3/ВП-38: two wrong attempts in a row after the method reach the full-solution fallback, never sooner", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    db.chunks = [{ material_id: "m1", page: 42, text: "117. Розв'яжи рівняння 2x + 3 = 7." }];
    callStructured.mockResolvedValueOnce({ result: { methodUk: "Метод: перенеси доданки." }, model: {}, costUsd: 0 });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");

    callStructured.mockResolvedValueOnce({
      result: { messageKind: "attempt", verdict: "incorrect_or_partial", explanationUk: "Не так — перевір знак." },
      model: {},
      costUsd: 0,
    });
    const r2 = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "x = 5");
    expect(r2.content).toBe("Не так — перевір знак.");
    const afterFirst = db.messages!.filter((m) => m.author === "ai").at(-1)!;
    expect(afterFirst.meta).toMatchObject({ stage: "attempt_feedback", attemptNo: 1 });

    callStructured.mockResolvedValueOnce({
      result: { messageKind: "attempt", verdict: "incorrect_or_partial", explanationUk: "Досі не так." },
      model: {},
      costUsd: 0,
    });
    callStructured.mockResolvedValueOnce({ result: { solutionUk: "Повний розв'язок: x = 2." }, model: {}, costUsd: 0 });
    const r3 = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "x = 6");
    expect(r3.content).toBe("Повний розв'язок: x = 2.");
    const afterSecond = db.messages!.filter((m) => m.author === "ai").at(-1)!;
    expect(afterSecond.meta).toMatchObject({ stage: "fallback" });
  });

  it("КП-6/BUG-013: the safety override wins mid-cycle and the attempt counter is untouched", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    db.chunks = [{ material_id: "m1", page: 42, text: "117. Розв'яжи рівняння 2x + 3 = 7." }];
    callStructured.mockResolvedValueOnce({ result: { methodUk: "Метод: перенеси доданки." }, model: {}, costUsd: 0 });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");

    moderateMessage.mockResolvedValue(URGENT);
    const urgentReply = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "хтось мене б'є вдома");
    expect(urgentReply.content).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
    expect(callStructured).toHaveBeenCalledTimes(1); // only the earlier "method" call — no attempt_feedback call was made

    moderateMessage.mockResolvedValue(NOT_URGENT);
    callStructured.mockResolvedValueOnce({
      result: { messageKind: "attempt", verdict: "incorrect_or_partial", explanationUk: "Ще не так." },
      model: {},
      costUsd: 0,
    });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "x = 5");
    const lastTagged = db.messages!.filter((m) => (m.meta as Record<string, unknown>)?.kind === "homework_problem").at(-1)!;
    expect(lastTagged.meta).toMatchObject({ stage: "attempt_feedback", attemptNo: 1 }); // first real attempt, not second
  });

  it("КП-5: asking for the answer outright before attempts are exhausted never advances the stage or counter", async () => {
    db.material_problems = [{ material_id: "m1", page: 42, topic_id: "top1", number: "117" }];
    db.materials = [{ id: "m1", title: "Математика 5", name: "math5.pdf" }];
    db.chunks = [{ material_id: "m1", page: 42, text: "117. Розв'яжи рівняння 2x + 3 = 7." }];
    callStructured.mockResolvedValueOnce({ result: { methodUk: "Метод: перенеси доданки." }, model: {}, costUsd: 0 });
    await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "поясни задачу №117");

    callStructured.mockResolvedValueOnce({
      result: { messageKind: "give_me_answer_request", verdict: null, explanationUk: "Спробуй спершу сама — ось метод ще раз." },
      model: {},
      costUsd: 0,
    });
    const reply = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "просто дай відповідь");
    expect(reply.content).toBe("Спробуй спершу сама — ось метод ще раз.");
    const saved = db.messages!.filter((m) => m.author === "ai").at(-1)!;
    expect(saved.meta).toMatchObject({ stage: "method", attemptNo: 0 });
  });

  it("ordinary questions with no problem number still go through the plain Q&A path unaffected", async () => {
    callStructured.mockResolvedValueOnce({ result: { answerUk: "Дріб — це частина цілого." }, model: {}, costUsd: 0 });
    const reply = await askTopicChat("fam1", "child1", "Зірочка", "Ліра", "f", "subj1", "Математика", "top1", "Дроби", "що таке дріб?");
    expect(reply.content).toBe("Дріб — це частина цілого.");
  });
});
