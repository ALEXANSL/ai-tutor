import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { asRole, connect, createAuthUser, defaults, errorCode } from "./helpers";

let db: pg.Client;
let family: string, otherFamily: string, child: string, secondChild: string, parentAuth: string, childAuth: string, chat: string;
const append = "select * from public.append_friend_message($1,$2,$3,$4,$5,$6,$7)";
const edit = "select * from public.edit_friend_chat($1,$2,$3,$4,$5,$6)";
const manage = "select * from public.manage_voice_session($1,$2,$3,$4,$5)";
const claim = "select * from public.claim_voice_turn($1,$2,$3)";
async function start(kind = "friend", client = db) {
  return (await client.query(manage, [family, child, { kind, chatId: chat }, null, false])).rows[0];
}
beforeAll(async () => {
  db = connect(); await db.connect();
  parentAuth = await createAuthUser(db, "s46.parent@example.com");
  childAuth = await createAuthUser(db, "s46.child@example.com");
  const parent = await db.query("select * from public.register_app_user($1,'parent',$2)", [parentAuth, JSON.stringify(defaults)]);
  family = parent.rows[0].family_id;
  const registered = await db.query("select * from public.register_app_user($1,'child',$2)", [childAuth, JSON.stringify(defaults)]);
  child = (await db.query("select id from public.child_profile where app_user_id=$1", [registered.rows[0].app_user_id])).rows[0].id;
  const auth = await createAuthUser(db, "s46.second.child@example.com");
  const second = await db.query("select * from public.register_app_user($1,'child',$2)", [auth, JSON.stringify(defaults)]);
  secondChild = (await db.query("select id from public.child_profile where app_user_id=$1", [second.rows[0].app_user_id])).rows[0].id;
  otherFamily = (await db.query("insert into public.families(timezone,locale) values('Europe/Kyiv','uk') returning id")).rows[0].id;
});
beforeEach(async () => {
  await db.query("delete from public.voice_sessions where family_id=$1", [family]);
  chat = (await db.query("insert into public.chats(family_id,child_profile_id,kind) values($1,$2,'friend') returning id", [family, child])).rows[0].id;
});
afterAll(async () => { await db.query("delete from public.families where id=any($1)", [[family, otherFamily]]); await db.end(); });

describe("friend thread mutation boundaries", () => {
  it("stores voice transcripts and derives a bounded initial thread title", async () => {
    await db.query(append, [family, child, chat, 0, "child", "а".repeat(80), true]);
    expect((await db.query("select title from public.chats where id=$1", [chat])).rows[0].title).toBe("а".repeat(60));
    expect((await db.query("select author,type from public.messages where chat_id=$1", [chat])).rows).toEqual([{ author: "child", type: "voice_transcript" }]);
  });
  it("rejects wrong family, wrong child, missing thread and NULL revision", async () => {
    for (const args of [[otherFamily, child, chat, 0], [family, secondChild, chat, 0], [family, child, "00000000-0000-0000-0000-000000000000", 0], [family, child, chat, null]]) {
      await expect(db.query(append, [...args, "child", "Привіт", false])).rejects.toThrow("chat_changed");
    }
    expect((await db.query("select count(*) from public.messages where chat_id=$1", [chat])).rows[0].count).toBe("0");
  });
  it("clears only child context and refuses a late AI response, retaining the parent transcript", async () => {
    await db.query(append, [family, child, chat, 0, "child", "Стара розмова", false]);
    const cleared = (await db.query(edit, [family, child, chat, 0, "clear", null])).rows[0];
    expect(cleared.revision).toBe(1);
    await expect(db.query(append, [family, child, chat, 0, "ai", "Запізніла відповідь", false])).rejects.toThrow("chat_changed");
    await db.query(append, [family, child, chat, 1, "child", "Нове питання", false]);
    expect((await db.query("select m.content from public.messages m join public.chats c on c.id=m.chat_id where c.id=$1 and m.created_at>c.cleared_at", [chat])).rows).toEqual([{ content: "Нове питання" }]);
    const parent = await asRole(db, { role: "authenticated", sub: parentAuth }, () => db.query("select content from public.messages where chat_id=$1 order by created_at", [chat]));
    expect(parent.rows.map((m) => m.content)).toEqual(["Стара розмова", "Нове питання"]);
  });
  it("timestamps a new message after a clear even inside the same transaction", async () => {
    await db.query("begin");
    try {
      await db.query(edit, [family, child, chat, 0, "clear", null]);
      await db.query(append, [family, child, chat, 1, "child", "Після очищення", false]);
      const { rows } = await db.query("select m.content from public.messages m join public.chats c on c.id=m.chat_id where c.id=$1 and m.created_at>c.cleared_at", [chat]);
      expect(rows).toEqual([{ content: "Після очищення" }]);
    } finally { await db.query("rollback"); }
  });
  it("archives without deleting transcript and refuses subsequent writes", async () => {
    await db.query(append, [family, child, chat, 0, "child", "Збережений текст", false]);
    const row = (await db.query(edit, [family, child, chat, 0, "archive", null])).rows[0];
    expect(row.archived_at).toBeInstanceOf(Date); expect(row.revision).toBe(1);
    await expect(db.query(append, [family, child, chat, 1, "ai", "Відповідь", false])).rejects.toThrow("chat_changed");
    expect((await db.query("select count(*) from public.messages where chat_id=$1", [chat])).rows[0].count).toBe("1");
  });
  it("preserves a chosen title without invalidating pending replies and rejects invalid edits", async () => {
    const row = (await db.query(edit, [family, child, chat, 0, "rename", "  Космос  "])).rows[0];
    expect(row.title).toBe("Космос"); expect(row.revision).toBe(0);
    await db.query(append, [family, child, chat, 0, "child", "Перше питання", false]);
    expect((await db.query("select title from public.chats where id=$1", [chat])).rows[0].title).toBe("Космос");
    for (const title of [null, " ", "а".repeat(61)]) await expect(db.query(edit, [family, child, chat, 0, "rename", title])).rejects.toThrow("invalid_title");
    await expect(db.query(edit, [otherFamily, child, chat, 0, "clear", null])).rejects.toThrow("chat_changed");
    await expect(db.query(edit, [family, secondChild, chat, 0, "archive", null])).rejects.toThrow("chat_changed");
    await expect(db.query(edit, [family, child, chat, 0, "unknown", null])).rejects.toThrow("invalid_action");
    await db.query(edit, [family, child, chat, 0, "clear", null]);
    await expect(db.query(edit, [family, child, chat, 0, "archive", null])).rejects.toThrow("chat_changed");
  });
});

describe("voice leases, quotas and family isolation", () => {
  it("rejects missing target kind and wrong family before session creation", async () => {
    for (const target of [null, {}, { kind: "other" }]) await expect(db.query(manage, [family, child, target, null, false])).rejects.toThrow("invalid_target");
    await expect(db.query(manage, [otherFamily, child, { kind: "friend" }, null, false])).rejects.toThrow("not_found");
  });
  it("uses a 60-second server lease bounded by the next Kyiv day for friend chat", async () => {
    const row = await start();
    const duration = (row.expires_at.getTime() - row.started_at.getTime()) / 1000;
    expect(duration).toBeGreaterThan(0); expect(duration).toBeLessThanOrEqual(60.01);
    expect((await db.query("select expires_at<=((date_trunc('day',started_at at time zone 'Europe/Kyiv')+interval '1 day') at time zone 'Europe/Kyiv') as bounded from public.voice_sessions where id=$1", [row.id])).rows[0].bounded).toBe(true);
  });
  it("ends a replaced lease and repeated stop cannot inflate recorded duration", async () => {
    const first = await start(); const second = await start("course");
    expect((await db.query("select ended_at is not null as ended from public.voice_sessions where id=$1", [first.id])).rows[0].ended).toBe(true);
    const closed = (await db.query(manage, [family, child, null, second.id, true])).rows[0];
    const again = (await db.query(manage, [family, child, null, second.id, true])).rows[0];
    expect(again.ended_at).toEqual(closed.ended_at);
    await expect(db.query(manage, [family, child, null, second.id, false])).rejects.toThrow("voice_expired");
  });
  it("serializes concurrent session opens to one active lease per child", async () => {
    const other = connect(); await other.connect();
    try {
      await Promise.all([start("friend"), start("friend", other)]);
      expect((await db.query("select count(*) from public.voice_sessions where child_profile_id=$1 and ended_at is null", [child])).rows[0].count).toBe("1");
    } finally { await other.end(); }
  });
  it("allows one in-flight turn and rejects wrong-family, expired and closed claims", async () => {
    const row = await start();
    await expect(db.query(claim, [otherFamily, child, row.id])).rejects.toThrow("voice_expired_or_busy");
    await db.query(claim, [family, child, row.id]);
    await expect(db.query(claim, [family, child, row.id])).rejects.toThrow("voice_expired_or_busy");
    await db.query("update public.voice_sessions set expires_at=clock_timestamp()-interval '1 second',busy_until=null where id=$1", [row.id]);
    await expect(db.query(claim, [family, child, row.id])).rejects.toThrow("voice_expired_or_busy");
    await expect(db.query(manage, [family, child, null, row.id, false])).rejects.toThrow("voice_expired");
  });
  it("blocks friend voice at 600 seconds, but leaves lesson/course voice available", async () => {
    // Synthetic completed quota on this Kyiv accounting day, independent of test runtime.
    await db.query(`insert into public.voice_sessions(family_id,child_profile_id,target,started_at,expires_at,ended_at)
      select $1,$2,'{"kind":"friend"}',d,d+interval '600 seconds',d+interval '600 seconds'
      from (select date_trunc('day',clock_timestamp() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv' as d) as day`, [family, child]);
    await expect(start()).rejects.toThrow("voice_limit");
    expect((await start("lesson")).target.kind).toBe("lesson");
    expect((await start("course")).target.kind).toBe("course");
  });
  it("does not charge completed voice from the previous Kyiv day", async () => {
    await db.query(`insert into public.voice_sessions(family_id,child_profile_id,target,started_at,expires_at,ended_at)
      select $1,$2,'{"kind":"friend"}',d-interval '600 seconds',d,d
      from (select date_trunc('day',clock_timestamp() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv' as d) as day`, [family, child]);
    expect((await start()).target.kind).toBe("friend");
  });
  it("seeds both budget-deferred voice routes for newly registered families", async () => {
    expect((await db.query("select role,params->>'budget_policy' as policy from public.model_routes where family_id=$1 and role like 'voice_%' order by role", [family])).rows).toEqual([{ role: "voice_reply", policy: "defer" }, { role: "voice_transcription", policy: "defer" }]);
  });
});

it("denies anon/authenticated direct voice-session reads and mutation RPC calls", async () => {
  for (const who of [{ role: "anon" } as const, { role: "authenticated", sub: childAuth } as const]) {
    const probes: [string, unknown[]][] = [
      ["select * from public.voice_sessions", []],
      [append, [family, child, chat, 0, "child", "Привіт", false]],
      [edit, [family, child, chat, 0, "clear", null]],
      [manage, [family, child, { kind: "friend" }, null, false]],
      [claim, [family, child, chat]],
    ];
    for (const [sql, args] of probes) expect(await asRole(db, who, () => errorCode(db, sql, args))).toBe("42501");
  }
});
