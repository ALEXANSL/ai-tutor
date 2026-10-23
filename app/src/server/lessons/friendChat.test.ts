import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S46 (2026-10-23, "окремі іменовані чати"): a small in-memory fake for
 * `chats`/`messages` — real enough to exercise filtering (`eq`/`is`),
 * ownership checks, counting (for auto-numbered titles) and inserts/updates,
 * without a real Supabase client. `.then()` makes a filtered builder
 * directly awaitable for the `{ count }` query style `scope.count()` uses
 * (real `PostgrestFilterBuilder` is thenable the same way).
 */
interface ChatRow { [key: string]: unknown; id: string; family_id: string; child_profile_id: string; kind: string; title: string | null; created_at: string; hidden_from_child_at: string | null }
interface MessageRow { [key: string]: unknown; id: string; family_id: string; chat_id: string; author: string; type: string; content: string; created_at: string }

let chats: ChatRow[] = [];
let messages: MessageRow[] = [];
let nextId = 1;
function freshId(prefix: string) { return `${prefix}${nextId++}`; }

function applyFilters(rows: Record<string, unknown>[], filters: [string, unknown][]) {
  return rows.filter((row) => filters.every(([k, v]) => (v === null ? row[k] == null : row[k] === v)));
}
function queryBuilder(rows: Record<string, unknown>[], filters: [string, unknown][] = []) {
  const builder = {
    eq: (k: string, v: unknown) => queryBuilder(rows, [...filters, [k, v]]),
    is: (k: string, v: unknown) => queryBuilder(rows, [...filters, [k, v]]),
    order: () => builder,
    limit: () => builder,
    returns: async () => ({ data: applyFilters(rows, filters), error: null }),
    maybeSingle: async () => ({ data: applyFilters(rows, filters)[0] ?? null, error: null }),
    then: (resolve: (v: { count: number }) => void) => resolve({ count: applyFilters(rows, filters).length }),
  };
  return builder;
}
function tableOf(table: string) { return table === "chats" ? chats : messages; }
const scope = {
  select: (table: string) => queryBuilder(tableOf(table), [["family_id", "fam1"]]),
  count: (table: string) => queryBuilder(tableOf(table), [["family_id", "fam1"]]),
  client: {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        const full = { id: freshId(table), created_at: "2026-10-23T00:00:00Z", ...row };
        tableOf(table).push(full as never);
        return { select: () => ({ single: async () => ({ data: full, error: null }) }) };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (k: string, v: unknown) => {
          const row = (chats as Record<string, unknown>[]).find((c) => c[k] === v);
          if (row) Object.assign(row, patch);
          return Promise.resolve({ error: null });
        },
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

const { askFriendChat, listFriendChats, createFriendChat, hideFriendChat, listFriendChatMessages } = await import("./friendChat");

beforeEach(() => {
  chats = [{ id: "chat1", family_id: "fam1", child_profile_id: "child1", kind: "friend", title: "Розмова 1", created_at: "2026-10-01T00:00:00Z", hidden_from_child_at: null }];
  messages = [];
  nextId = 1;
  callStructured.mockReset();
  moderateMessage.mockReset();
  recordSafetyEvent.mockClear();
});

describe("askFriendChat + urgent moderation (NFR-SAFE-4)", () => {
  it("urgent severity ALWAYS replaces the model's own reply with the deterministic go-to-dad sentence", async () => {
    moderateMessage.mockResolvedValue({ category: "self_harm", severity: "urgent", confidence: 0.95, layer1Flagged: true, escalated: false, reasonUk: "x" });
    callStructured.mockResolvedValue({ result: { answerUk: "Модель могла б сказати щось зовсім інше тут" }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askFriendChat("fam1", "child1", "chat1", "Зірочка", "Ліра", "f", "мені дуже погано, я хочу собі зашкодити");

    expect(reply.content).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
    expect(reply.content).not.toContain("Модель могла б сказати");
  });

  it("non-urgent -> the model's own reply is used as-is", async () => {
    moderateMessage.mockResolvedValue({ category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" });
    callStructured.mockResolvedValue({ result: { answerUk: "Драконі теж люблять космос!" }, model: {}, costUsd: 0, fallbackUsed: false });

    const reply = await askFriendChat("fam1", "child1", "chat1", "Зірочка", "Ліра", "f", "мені подобаються дракони");

    expect(reply.content).toBe("Драконі теж люблять космос!");
  });

  it("rejects a chat id that is not this child's own friend chat", async () => {
    await expect(askFriendChat("fam1", "someone-else", "chat1", "Зірочка", "Ліра", "f", "привіт")).rejects.toThrow("friend chat not found");
  });
});

describe("multiple named friend chats (S46, 2026-10-23)", () => {
  it("lists only this child's own, non-hidden chats, most recent first", async () => {
    chats.push({ id: "chat2", family_id: "fam1", child_profile_id: "child1", kind: "friend", title: "Розмова 2", created_at: "2026-10-02T00:00:00Z", hidden_from_child_at: null });
    chats.push({ id: "chat-hidden", family_id: "fam1", child_profile_id: "child1", kind: "friend", title: "Стара", created_at: "2026-10-03T00:00:00Z", hidden_from_child_at: "2026-10-04T00:00:00Z" });
    chats.push({ id: "chat-other-child", family_id: "fam1", child_profile_id: "child2", kind: "friend", title: "Не моя", created_at: "2026-10-05T00:00:00Z", hidden_from_child_at: null });

    const list = await listFriendChats("fam1", "child1");

    expect(list.map((c) => c.id)).toEqual(["chat1", "chat2"]);
  });

  it("falls back to a date-based title for a legacy chat created before titles existed", async () => {
    chats[0]!.title = null;
    const list = await listFriendChats("fam1", "child1");
    expect(list[0]!.title).toMatch(/^Розмова від \d{2}\.\d{2}$/);
  });

  it("creates a new, separately numbered chat without touching the existing one", async () => {
    const created = await createFriendChat("fam1", "child1");
    expect(created.title).toBe("Розмова 2");
    expect(chats).toHaveLength(2);
    expect(chats[0]!.id).toBe("chat1");
  });

  it("hides a chat from the child's own list without deleting it (parent still sees it)", async () => {
    await hideFriendChat("fam1", "child1", "chat1");
    expect(chats[0]!.hidden_from_child_at).not.toBeNull();
    expect(await listFriendChats("fam1", "child1")).toEqual([]);
  });

  it("refuses to hide another child's chat", async () => {
    chats.push({ id: "chat-other", family_id: "fam1", child_profile_id: "child2", kind: "friend", title: "Не моя", created_at: "2026-10-02T00:00:00Z", hidden_from_child_at: null });
    await expect(hideFriendChat("fam1", "child1", "chat-other")).rejects.toThrow("friend chat not found");
    expect(chats.find((c) => c.id === "chat-other")!.hidden_from_child_at).toBeNull();
  });

  it("reads messages only from a chat this child actually owns", async () => {
    messages.push({ id: "m1", family_id: "fam1", chat_id: "chat1", author: "child", type: "text", content: "Привіт", created_at: "2026-10-01T00:01:00Z" });
    expect(await listFriendChatMessages("fam1", "child1", "chat1")).toEqual([{ id: "m1", author: "child", content: "Привіт", createdAt: "2026-10-01T00:01:00Z" }]);
    await expect(listFriendChatMessages("fam1", "someone-else", "chat1")).rejects.toThrow("friend chat not found");
  });
});
