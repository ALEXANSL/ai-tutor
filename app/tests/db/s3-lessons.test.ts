/**
 * S3 database tests: RLS on the new lesson-orchestrator tables (NFR-PRIV-4)
 * and the `step_attempts.idempotency_key` uniqueness that backs "an answer
 * resent after reconnecting never creates a duplicate" (US-6.5 КП-2).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asRole, connect, createAuthUser, defaults, errorCode } from "./helpers";

/** Like `errorCode`, but for a service-role statement outside any `asRole` transaction. */
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
  childProfile: string;
  subject: string;
  topic: string;
  libraryItem: string;
  libraryStep: string;
  session: string;
  otherFamily: string;
  otherChildProfile: string;
};

beforeAll(async () => {
  db = connect();
  await db.connect();

  ids.parentAuth = await createAuthUser(db, "s3.parent@example.com");
  ids.childAuth = await createAuthUser(db, "s3.child@example.com");
  ids.strangerAuth = await createAuthUser(db, "s3.stranger@example.com");

  const parent = await db.query("select * from public.register_app_user($1, 'parent', $2)", [ids.parentAuth, JSON.stringify(defaults)]);
  const child = await db.query("select * from public.register_app_user($1, 'child', $2)", [ids.childAuth, JSON.stringify(defaults)]);
  ids.family = parent.rows[0].family_id;
  const profile = await db.query("select id from public.child_profile where app_user_id = $1", [child.rows[0].app_user_id]);
  ids.childProfile = profile.rows[0].id;

  // `register_app_user` already seeds the family's default subjects
  // (config/family-defaults.json), including "math" — reuse it instead of a
  // second row with the same (owner_family_id, code).
  const subj = await db.query("select id from public.subjects where owner_family_id = $1 and code = 'math'", [ids.family]);
  ids.subject = subj.rows[0].id;
  const topic = await db.query(
    "insert into public.topics (owner_family_id, subject_id, title, sort_order) values ($1, $2, 'Дроби', 0) returning id",
    [ids.family, ids.subject],
  );
  ids.topic = topic.rows[0].id;

  const item = await db.query(
    `insert into public.library_items (owner_family_id, subject_id, topic_id, title, status)
     values ($1, $2, $3, 'Блок: Дроби', 'active') returning id`,
    [ids.family, ids.subject, ids.topic],
  );
  ids.libraryItem = item.rows[0].id;
  const step = await db.query(
    `insert into public.library_steps (owner_family_id, item_id, sort_order, type, content)
     values ($1, $2, 0, 'slide', '{"textUk": "..."}'::jsonb) returning id`,
    [ids.family, ids.libraryItem],
  );
  ids.libraryStep = step.rows[0].id;

  const session = await db.query(
    `insert into public.lesson_sessions (family_id, child_profile_id, subject_id, topic_id, planned_minutes, current_step_id)
     values ($1, $2, $3, $4, 30, $5) returning id`,
    [ids.family, ids.childProfile, ids.subject, ids.topic, ids.libraryStep],
  );
  ids.session = session.rows[0].id;

  const other = await db.query("insert into public.families (timezone, locale) values ('Europe/Kyiv', 'uk') returning id");
  ids.otherFamily = other.rows[0].id;
  const otherParentAuth = await createAuthUser(db, "s3.other.parent@example.com");
  await db.query("insert into public.app_users (auth_user_id, family_id, role) values ($1, $2, 'parent')", [otherParentAuth, ids.otherFamily]);
  await db.query("insert into public.parent_settings (family_id) values ($1)", [ids.otherFamily]);
});

afterAll(async () => {
  await db.query("delete from public.families where id in ($1, $2)", [ids.family, ids.otherFamily]);
  await db.end();
});

describe("S3 lesson tables — RLS (NFR-PRIV-4)", () => {
  it("the parent can read the session, its block-less library item and steps", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      const sessions = await db.query("select id from public.lesson_sessions where id = $1", [ids.session]);
      expect(sessions.rowCount).toBe(1);
      const items = await db.query("select id from public.library_items where id = $1", [ids.libraryItem]);
      expect(items.rowCount).toBe(1);
      const steps = await db.query("select id from public.library_steps where id = $1", [ids.libraryStep]);
      expect(steps.rowCount).toBe(1);
    });
  });

  it("the child can read her own session and the active library item, but not a superseded one", async () => {
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      const sessions = await db.query("select id from public.lesson_sessions where id = $1", [ids.session]);
      expect(sessions.rowCount).toBe(1);
      const items = await db.query("select id from public.library_items where id = $1", [ids.libraryItem]);
      expect(items.rowCount).toBe(1);
    });

    await db.query("update public.library_items set status = 'superseded' where id = $1", [ids.libraryItem]);
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      const items = await db.query("select id from public.library_items where id = $1", [ids.libraryItem]);
      expect(items.rowCount).toBe(0);
    });
    await db.query("update public.library_items set status = 'active' where id = $1", [ids.libraryItem]);
  });

  it("a stranger (no app_users row) sees nothing at all", async () => {
    await asRole(db, { role: "authenticated", sub: ids.strangerAuth }, async () => {
      const sessions = await db.query("select id from public.lesson_sessions where id = $1", [ids.session]);
      expect(sessions.rowCount).toBe(0);
      const items = await db.query("select id from public.library_items where id = $1", [ids.libraryItem]);
      expect(items.rowCount).toBe(0);
    });
  });

  it("another family's parent cannot read this family's session", async () => {
    const otherParent = (await db.query("select auth_user_id from public.app_users where family_id = $1", [ids.otherFamily])).rows[0]
      .auth_user_id as string;
    await asRole(db, { role: "authenticated", sub: otherParent }, async () => {
      const sessions = await db.query("select id from public.lesson_sessions where id = $1", [ids.session]);
      expect(sessions.rowCount).toBe(0);
    });
  });

  it("no direct client writes: authenticated cannot insert a session even for her own family", async () => {
    const code = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      errorCode(
        db,
        `insert into public.lesson_sessions (family_id, child_profile_id, subject_id, topic_id, planned_minutes)
         values ($1, $2, $3, $4, 30)`,
        [ids.family, ids.childProfile, ids.subject, ids.topic],
      ),
    );
    expect(code).toBe("42501"); // insufficient_privilege
  });
});

describe("step_attempts.idempotency_key (US-6.5 КП-2: resend after reconnecting never duplicates)", () => {
  it("rejects a second attempt row with the same idempotency key", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    await db.query(
      `insert into public.step_attempts (family_id, session_id, step_id, channel, verdict, idempotency_key)
       values ($1, $2, $3, 'text', 'correct', $4)`,
      [ids.family, ids.session, ids.libraryStep, key],
    );
    const code = await serviceErrorCode(
      db,
      `insert into public.step_attempts (family_id, session_id, step_id, channel, verdict, idempotency_key)
       values ($1, $2, $3, 'text', 'correct', $4)`,
      [ids.family, ids.session, ids.libraryStep, key],
    );
    expect(code).toBe("23505"); // unique_violation
  });
});

describe("chats (US-8.1, 8.2): one chat per child per topic", () => {
  it("rejects a second subject_topic chat for the same child and topic", async () => {
    await db.query(
      `insert into public.chats (family_id, child_profile_id, kind, subject_id, topic_id) values ($1, $2, 'subject_topic', $3, $4)`,
      [ids.family, ids.childProfile, ids.subject, ids.topic],
    );
    const code = await serviceErrorCode(
      db,
      `insert into public.chats (family_id, child_profile_id, kind, subject_id, topic_id) values ($1, $2, 'subject_topic', $3, $4)`,
      [ids.family, ids.childProfile, ids.subject, ids.topic],
    );
    expect(code).toBe("23505");
  });
});
