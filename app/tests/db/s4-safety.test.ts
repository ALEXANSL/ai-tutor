/**
 * S4 database tests (ADR-009, ADR-010, ADR-012): the new `safety_events` /
 * `outbound_deliveries` / `telegram_link_codes` tables (parent-only, no
 * direct client writes), the encrypted Telegram chat-id RPCs, the widened
 * `lesson_sessions.pause_reason` ('break') and its new break counters, the
 * per-child `break_after_minutes` setting, and the new `safety_moderator` /
 * `friend_chat` model routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asRole, connect, createAuthUser, defaults, errorCode } from "./helpers";

/** Like `errorCode`, but for a service-role statement outside any `asRole` transaction (no savepoint needed). */
async function serviceErrorCode(client: pg.Client, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await client.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? null;
  }
}

let db: pg.Client;
const ids = {} as {
  parentAuth: string;
  childAuth: string;
  strangerAuth: string;
  family: string;
  otherFamily: string;
  childProfile: string;
  safetyEvent: string;
};

beforeAll(async () => {
  db = connect();
  await db.connect();
  // Defensive, same reasoning as s3b-pedagogy.test.ts: guarantee a fresh family.
  await db.query("delete from public.families");

  ids.parentAuth = await createAuthUser(db, "s4.parent@example.com");
  ids.childAuth = await createAuthUser(db, "s4.child@example.com");
  ids.strangerAuth = await createAuthUser(db, "s4.stranger@example.com");

  const parent = await db.query("select * from public.register_app_user($1, 'parent', $2)", [ids.parentAuth, JSON.stringify(defaults)]);
  const child = await db.query("select * from public.register_app_user($1, 'child', $2)", [ids.childAuth, JSON.stringify(defaults)]);
  ids.family = parent.rows[0].family_id;
  const profile = await db.query("select id from public.child_profile where app_user_id = $1", [child.rows[0].app_user_id]);
  ids.childProfile = profile.rows[0].id;

  const other = await db.query("insert into public.families (timezone, locale) values ('Europe/Kyiv', 'uk') returning id");
  ids.otherFamily = other.rows[0].id;

  const event = await db.query(
    `insert into public.safety_events (family_id, child_profile_id, mode, category, severity, quote, model_confidence)
     values ($1, $2, 'lesson', 'sadness', 'normal', 'мені сумно', 0.8) returning id`,
    [ids.family, ids.childProfile],
  );
  ids.safetyEvent = event.rows[0].id;
});

afterAll(async () => {
  await db.query("delete from public.families where id in ($1, $2)", [ids.family, ids.otherFamily]);
  await db.end();
});

describe("model routes seeded for S4 roles (ADR-005)", () => {
  it("seeds safety_moderator (Haiku, budget-exempt by policy.ts) and friend_chat (Sonnet)", async () => {
    const { rows } = await db.query(
      "select role, primary_provider, primary_model from public.model_routes where family_id = $1 and role in ('safety_moderator', 'friend_chat') order by role",
      [ids.family],
    );
    expect(rows).toEqual([
      { role: "friend_chat", primary_provider: "anthropic", primary_model: "claude-sonnet-5" },
      { role: "safety_moderator", primary_provider: "anthropic", primary_model: "claude-haiku-4-5" },
    ]);
  });
});

describe("safety_events (parent-only, ADR-009)", () => {
  it("the parent reads her family's events", async () => {
    const { rows } = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      db.query("select id, category, quote from public.safety_events where family_id = $1", [ids.family]),
    );
    expect(rows).toEqual([{ id: ids.safetyEvent, category: "sadness", quote: "мені сумно" }]);
  });

  it("the child never reads the quote (NFR-PRIV-10, US-11.7 КП-2: only the parent sees it)", async () => {
    const { rows } = await asRole(db, { role: "authenticated", sub: ids.childAuth }, () =>
      db.query("select id from public.safety_events where family_id = $1", [ids.family]),
    );
    expect(rows).toEqual([]);
  });

  it("another family's parent sees nothing", async () => {
    const otherParentAuth = await createAuthUser(db, "s4.other.parent@example.com");
    await db.query("select * from public.register_app_user($1, 'parent', $2)", [otherParentAuth, JSON.stringify(defaults)]);
    // register_app_user reuses the single existing family in this MVP — attach a fresh row directly instead.
    await db.query("update public.app_users set family_id = $1 where auth_user_id = $2", [ids.otherFamily, otherParentAuth]);
    const { rows } = await asRole(db, { role: "authenticated", sub: otherParentAuth }, () =>
      db.query("select id from public.safety_events where family_id = $1", [ids.family]),
    );
    expect(rows).toEqual([]);
  });

  it("no direct client writes: authenticated cannot insert a safety event", async () => {
    const code = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      errorCode(
        db,
        `insert into public.safety_events (family_id, child_profile_id, mode, category, severity, quote)
         values ($1, $2, 'lesson', 'other', 'normal', 'x')`,
        [ids.family, ids.childProfile],
      ),
    );
    expect(code).toBe("42501"); // insufficient_privilege
  });
});

describe("outbound_deliveries (parent-only, ADR-010)", () => {
  it("the parent reads delivery attempts for her family; no direct client writes", async () => {
    await db.query(
      "insert into public.outbound_deliveries (family_id, safety_event_id, channel, status) values ($1, $2, 'email', 'sent')",
      [ids.family, ids.safetyEvent],
    );
    const { rows } = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      db.query("select channel, status from public.outbound_deliveries where family_id = $1", [ids.family]),
    );
    expect(rows).toEqual([{ channel: "email", status: "sent" }]);

    const code = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      errorCode(db, "insert into public.outbound_deliveries (family_id, channel) values ($1, 'telegram')", [ids.family]),
    );
    expect(code).toBe("42501");
  });
});

describe("telegram_link_codes (revoked entirely for anon/authenticated — a code in flight is a family secret)", () => {
  beforeAll(async () => {
    await db.query(
      "insert into public.telegram_link_codes (family_id, code, expires_at) values ($1, 'probe-code', now() + interval '10 minutes')",
      [ids.family],
    );
  });

  it("authenticated (even the parent, own family) cannot select it — no grant at all", async () => {
    const code = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      errorCode(db, "select code from public.telegram_link_codes where family_id = $1", [ids.family]),
    );
    expect(code).toBe("42501");
  });

  it("anon cannot select it either", async () => {
    const code = await asRole(db, { role: "anon" }, () => errorCode(db, "select code from public.telegram_link_codes limit 1"));
    expect(code).toBe("42501");
  });
});

describe("encrypted Telegram chat id (service-role RPCs only, NFR-PRIV-10)", () => {
  it("round-trips through set/get, and clear removes it", async () => {
    await db.query("select public.set_telegram_chat_id($1, '123456789', 'test-bot-token')", [ids.family]);
    const got = await db.query("select public.get_telegram_chat_id($1, 'test-bot-token')", [ids.family]);
    expect(got.rows[0].get_telegram_chat_id).toBe("123456789");

    // A different passphrase (wrong bot token) cannot decrypt it.
    const wrongCode = await serviceErrorCode(db, "select public.get_telegram_chat_id($1, 'wrong-token')", [ids.family]);
    expect(wrongCode).not.toBeNull();

    await db.query("select public.clear_telegram_chat_id($1)", [ids.family]);
    const after = await db.query("select public.get_telegram_chat_id($1, 'test-bot-token')", [ids.family]);
    expect(after.rows[0].get_telegram_chat_id).toBeNull();
  });

  it("is not callable by authenticated (server-only RPC)", async () => {
    const code = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      errorCode(db, "select public.get_telegram_chat_id($1, 'x')", [ids.family]),
    );
    expect(code).toBe("42501");
  });
});

describe("breaks (US-12.2): new columns and widened pause_reason", () => {
  it("child_profile.break_after_minutes defaults to 20", async () => {
    const { rows } = await db.query("select break_after_minutes from public.child_profile where id = $1", [ids.childProfile]);
    expect(rows[0].break_after_minutes).toBe(20);
  });

  it("lesson_sessions accepts pause_reason = 'break' and defaults the new counters to 0", async () => {
    const subj = await db.query("select id from public.subjects where owner_family_id = $1 and code = 'math'", [ids.family]);
    const topic = await db.query(
      "insert into public.topics (owner_family_id, subject_id, title, sort_order) values ($1, $2, 'T', 0) returning id",
      [ids.family, subj.rows[0].id],
    );
    const session = await db.query(
      `insert into public.lesson_sessions (family_id, child_profile_id, subject_id, topic_id, planned_minutes, pause_reason)
       values ($1, $2, $3, $4, 30, 'break') returning seconds_since_break, breaks_offered, breaks_taken, breaks_skipped, pause_reason`,
      [ids.family, ids.childProfile, subj.rows[0].id, topic.rows[0].id],
    );
    expect(session.rows[0]).toEqual({ seconds_since_break: 0, breaks_offered: 0, breaks_taken: 0, breaks_skipped: 0, pause_reason: "break" });
  });

  it("still rejects an unknown pause_reason", async () => {
    const subj = await db.query("select id from public.subjects where owner_family_id = $1 and code = 'math'", [ids.family]);
    const topic = await db.query("select id from public.topics where owner_family_id = $1 limit 1", [ids.family]);
    const code = await serviceErrorCode(
      db,
      `insert into public.lesson_sessions (family_id, child_profile_id, subject_id, topic_id, planned_minutes, pause_reason)
       values ($1, $2, $3, $4, 30, 'coffee_break')`,
      [ids.family, ids.childProfile, subj.rows[0].id, topic.rows[0].id],
    );
    expect(code).toBe("23514"); // check_violation
  });
});

describe("notifications.type accepts the new S4 types (already-generic check, no migration needed)", () => {
  it.each(["safety_alert", "external_delivery_failed", "telegram_linked", "break_missed"])("%s", async (type) => {
    const code = await serviceErrorCode(db, "insert into public.notifications (family_id, type, payload) values ($1, $2, '{}')", [ids.family, type]);
    expect(code).toBeNull();
  });
});
