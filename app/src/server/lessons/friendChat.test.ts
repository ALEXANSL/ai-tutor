import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { chats: [], messages: [], child_profile: [] };
const calls: { name: string; params: Row }[] = [];
const queries: { family: string; table: string; filters: [string, string, unknown][] }[] = [];
let clock = 0;
const now = () => new Date(Date.parse("2026-10-21T12:00:00Z") + ++clock * 1000).toISOString();
const chat = (id: string, family_id = "fam1", child_profile_id = "child1"): Row => ({ id, family_id, child_profile_id, kind: "friend", title: id, revision: 0, cleared_at: null, archived_at: null, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z" });
function query(family: string, table: string) {
  const record = { family, table, filters: [] as [string, string, unknown][] };
  queries.push(record);
  const orders: { key: string; asc: boolean }[] = [];
  let cap = Infinity;
  const read = () => tables[table]!.filter((r) => r.family_id === family)
    .filter((r) => record.filters.every(([op, key, v]) => op === "gt" ? String(r[key]) > String(v) : r[key] === v))
    .sort((a, b) => {
      for (const o of orders) { const c = String(a[o.key]).localeCompare(String(b[o.key])); if (c) return o.asc ? c : -c; }
      return 0;
    }).slice(0, cap).map((row) => ({ ...row }));
  const self = {
    eq: (k: string, v: unknown) => { record.filters.push(["eq", k, v]); return self; },
    is: (k: string, v: unknown) => { record.filters.push(["is", k, v]); return self; },
    gt: (k: string, v: unknown) => { record.filters.push(["gt", k, v]); return self; },
    order: (key: string, opts?: { ascending: boolean }) => { orders.push({ key, asc: opts?.ascending ?? true }); return self; },
    limit: (n: number) => { cap = n; return self; },
    maybeSingle: () => Promise.resolve({ data: read()[0] ?? null, error: null }),
    returns: () => Promise.resolve({ data: read(), error: null }),
  };
  return self;
}
function scope(family: string) {
  return {
    select: (table: string) => query(family, table),
    insert: (table: string, data: Row) => {
      const row = { ...chat(`new-${tables.chats!.length}`, family, String(data.child_profile_id)), ...data };
      tables[table]!.push(row);
      return { select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) };
    },
    client: { rpc: (name: string, params: Row) => {
      calls.push({ name, params });
      const c = tables.chats!.find((r) => r.id === params.p_chat_id && r.family_id === params.p_family_id && r.child_profile_id === params.p_child_id && r.kind === "friend" && !r.archived_at && r.revision === params.p_revision);
      let data: unknown = null;
      const error = c ? null : { message: "chat_changed" };
      if (c && name === "edit_friend_chat") {
        if (params.p_action === "clear") { c.cleared_at = now(); c.revision = Number(c.revision) + 1; }
        if (params.p_action === "archive") { c.archived_at = now(); c.revision = Number(c.revision) + 1; }
        if (params.p_action === "rename") c.title = params.p_title;
        c.updated_at = now(); data = c;
      }
      if (c && name === "append_friend_message") {
        const m = { id: `msg-${tables.messages!.length}`, family_id: family, chat_id: c.id, author: params.p_author, content: params.p_content, type: params.p_voice ? "voice_transcript" : "text", created_at: now() };
        tables.messages!.push(m); c.updated_at = m.created_at; data = { id: m.id, created_at: m.created_at };
      }
      const promise = Promise.resolve({ data, error });
      return { then: promise.then.bind(promise), single: () => promise };
    } },
  };
}
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => scope(family) }));
const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...a: unknown[]) => callStructured(...a) }));
const moderateMessage = vi.fn();
vi.mock("@/server/safety/moderate", () => ({ moderateMessage: (...a: unknown[]) => moderateMessage(...a) }));
const recordSafetyEvent = vi.fn().mockResolvedValue({ flagged: false });
vi.mock("@/server/safety/events", () => ({ recordSafetyEvent: (...a: unknown[]) => recordSafetyEvent(...a) }));
const { askFriendChat, getFriendChat, listFriendChats, createFriendChat, listFriendChatMessages, clearFriendChat, archiveFriendChat, renameFriendChat } = await import("./friendChat");
const ask = (id?: string, voice = false) => askFriendChat("fam1", "child1", "Зірочка", "Ліра", "f", "Розкажи про космос", id, voice);
function message(chat_id: string, content: string) { return { id: `old-${tables.messages!.length}`, family_id: "fam1", chat_id, author: "child", content, type: "text", created_at: "2026-10-20T11:00:00Z" }; }
beforeEach(() => {
  tables.chats = [chat("chat1"), { ...chat("chat2"), updated_at: "2026-10-21T09:00:00Z" }, chat("foreign", "fam2", "child2")];
  tables.messages = [];
  tables.child_profile = [{ id: "child1", family_id: "fam1" }, { id: "child2", family_id: "fam2" }];
  calls.length = 0; queries.length = 0; clock = 0;
  callStructured.mockReset().mockResolvedValue({ result: { answerUk: "Дракони теж люблять космос!" } });
  moderateMessage.mockReset().mockResolvedValue({ category: "none", severity: "none", confidence: 0.9, layer1Flagged: false, escalated: false, reasonUk: "" });
  recordSafetyEvent.mockClear();
});

describe("friend conversation boundaries", () => {
  it("uses only the selected thread context and scopes the lookup to family, child, kind and active state", async () => {
    tables.messages!.push(message("chat1", "Пам'ятай: дракони"), message("chat2", "ІНША РОЗМОВА"));
    await ask("chat1");
    const prompt = callStructured.mock.calls[0]![1].prompt;
    expect(prompt).toContain("Пам'ятай: дракони"); expect(prompt).not.toContain("ІНША РОЗМОВА");
    expect(calls.filter((c) => c.name === "append_friend_message").map((c) => c.params.p_chat_id)).toEqual(["chat1", "chat1"]);
    expect(queries[0]).toMatchObject({ family: "fam1", table: "chats" });
    expect(queries[0]!.filters).toEqual(expect.arrayContaining([["eq", "child_profile_id", "child1"], ["eq", "kind", "friend"], ["is", "archived_at", null], ["eq", "id", "chat1"]]));
  });
  it.each(["", "foreign", "missing", "other-child", "archived"])("refuses explicit unavailable chat %s without fallback or model calls", async (id) => {
    tables.chats!.push(chat("other-child", "fam1", "sibling"), { ...chat("archived"), archived_at: now() });
    const count = tables.chats!.length;
    await expect(ask(id)).rejects.toThrow("unavailable or changed");
    expect(tables.chats).toHaveLength(count); expect(tables.messages).toHaveLength(0); expect(callStructured).not.toHaveBeenCalled();
  });
  it("lists only active owned threads, newest first; an omitted id selects the latest", async () => {
    tables.chats!.push({ ...chat("archived"), archived_at: now() }, chat("sibling", "fam1", "someone-else"));
    expect((await listFriendChats("fam1", "child1")).map((c) => c.id)).toEqual(["chat2", "chat1"]);
    expect((await getFriendChat("fam1", "child1")).id).toBe("chat2");
  });
  it("keeps all visible messages instead of silently truncating a long conversation", async () => {
    for (let i = 0; i < 105; i++) tables.messages!.push({ ...message("chat1", `message-${i}`), created_at: new Date(Date.parse("2026-10-20T11:00:00Z") + i * 1000).toISOString() });
    const result = await listFriendChatMessages("fam1", "child1", "chat1");
    expect(result.messages).toHaveLength(105);
    expect(result.messages[0]!.content).toBe("message-0");
    expect(result.messages.at(-1)!.content).toBe("message-104");
  });
  it("creates a titled thread and refuses a child belonging to another family", async () => {
    const created = await createFriendChat("fam1", "child1", "  Космос  ");
    expect(created.title).toBe("Космос");
    expect(tables.chats!.at(-1)).toMatchObject({ family_id: "fam1", child_profile_id: "child1", kind: "friend" });
    const count = tables.chats!.length;
    await expect(createFriendChat("fam1", "child2")).rejects.toThrow("unavailable or changed"); expect(tables.chats).toHaveLength(count);
  });
});
describe("clearing and archiving preserve parent evidence", () => {
  it("clears displayed history and model context while retaining the transcript rows", async () => {
    tables.messages!.push(message("chat1", "OLD CONTEXT"));
    await clearFriendChat("fam1", "child1", "chat1");
    expect(tables.chats![0]!.revision).toBe(1); expect(tables.messages).toHaveLength(1);
    expect((await listFriendChatMessages("fam1", "child1", "chat1")).messages).toEqual([]);
    await ask("chat1"); expect(callStructured.mock.calls[0]![1].prompt).not.toContain("OLD CONTEXT");
    expect(tables.messages![0]!.content).toBe("OLD CONTEXT");
    expect((await listFriendChatMessages("fam1", "child1", "chat1")).messages).toHaveLength(2);
  });
  it("rejects a voice turn carrying an older expected revision before generation or insertion", async () => {
    tables.chats![0]!.revision = 3;
    await expect(askFriendChat("fam1", "child1", "Зірочка", "Ліра", "f", "Стара голосова репліка", "chat1", true, 2)).rejects.toThrow("unavailable or changed");
    expect(tables.messages).toHaveLength(0); expect(callStructured).not.toHaveBeenCalled();
    expect(moderateMessage).not.toHaveBeenCalled();
  });
  it("discards a model answer that finishes after another tab clears the chat", async () => {
    callStructured.mockImplementation(async () => { await clearFriendChat("fam1", "child1", "chat1"); return { result: { answerUk: "LATE ANSWER" } }; });
    await expect(ask("chat1")).rejects.toThrow("unavailable or changed");
    expect(tables.messages!.map((m) => m.author)).toEqual(["child"]);
    expect((await listFriendChatMessages("fam1", "child1", "chat1")).messages).toEqual([]);
    expect(recordSafetyEvent).toHaveBeenCalledTimes(1);
  });
  it("archives only the chosen thread and prevents subsequent sending without deleting transcript", async () => {
    tables.messages!.push(message("chat1", "Транскрипт для тата"));
    await archiveFriendChat("fam1", "child1", "chat1");
    expect((await listFriendChats("fam1", "child1")).map((c) => c.id)).toEqual(["chat2"]);
    expect(tables.messages).toHaveLength(1); await expect(ask("chat1")).rejects.toThrow("unavailable or changed");
  });
  it("renames only the requested thread and rejects a blank title", async () => {
    await renameFriendChat("fam1", "child1", "chat1", "  Космічні пригоди  ");
    expect(tables.chats![0]!.title).toBe("Космічні пригоди"); expect(tables.chats![1]!.title).toBe("chat2");
    await expect(renameFriendChat("fam1", "child1", "chat1", "   ")).rejects.toThrow();
  });
});
describe("moderation and voice transcripts", () => {
  it("urgent severity overrides any model reply with the deterministic go-to-dad sentence", async () => {
    moderateMessage.mockResolvedValue({ category: "self_harm", severity: "urgent", confidence: 0.95, layer1Flagged: true, escalated: false, reasonUk: "x" });
    callStructured.mockResolvedValue({ result: { answerUk: "UNSAFE MODEL REPLY" } });
    expect((await ask("chat1")).content).toBe("Це звучить дуже серйозно. Будь ласка, зараз піди й скажи про це тату — він удома і допоможе.");
    expect(tables.messages!.at(-1)!.content).not.toContain("UNSAFE MODEL REPLY");
  });
  it("preserves ordinary replies and records both voice turns in the selected thread as transcripts", async () => {
    expect((await ask("chat1", true)).content).toBe("Дракони теж люблять космос!");
    expect(tables.messages!.map((m) => [m.chat_id, m.type, m.author])).toEqual([["chat1", "voice_transcript", "child"], ["chat1", "voice_transcript", "ai"]]);
    expect(recordSafetyEvent).toHaveBeenCalledWith("fam1", "child1", "friend_chat", "Розкажи про космос", expect.anything(), { chatId: "chat1" });
  });
});
