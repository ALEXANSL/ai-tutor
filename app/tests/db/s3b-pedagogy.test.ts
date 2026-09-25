/**
 * S3b database tests (ADR-022, D-55): `library_items.status` extension
 * (`needs_review`), the `pedagogy`/`child_feedback` columns, and RLS on the
 * new `library_item_reviews` table — only the parent may read a block's
 * review history (US-6.10 КП-4: the passport detail is never for the
 * child), and a `needs_review` block stays invisible to the child through
 * the SAME `library_items_select` policy S3 already has (not re-tested
 * here — see `s3-lessons.test.ts`).
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
  family: string;
  childProfile: string;
  subject: string;
  topic: string;
  libraryItem: string;
  otherFamily: string;
};

beforeAll(async () => {
  db = connect();
  await db.connect();

  // Defensive (MVP is a single family, `register_app_user` reuses whichever
  // one already exists — `20260925100200_s0_parent_child_persona.sql`):
  // guarantee a clean slate regardless of another test file's cleanup
  // timing, so `register_app_user` below always CREATES a fresh family with
  // its subjects freshly seeded, rather than silently reusing a leftover one.
  await db.query("delete from public.families");

  ids.parentAuth = await createAuthUser(db, "s3b.parent@example.com");
  ids.childAuth = await createAuthUser(db, "s3b.child@example.com");

  const parent = await db.query("select * from public.register_app_user($1, 'parent', $2)", [ids.parentAuth, JSON.stringify(defaults)]);
  const child = await db.query("select * from public.register_app_user($1, 'child', $2)", [ids.childAuth, JSON.stringify(defaults)]);
  ids.family = parent.rows[0].family_id;
  const profile = await db.query("select id from public.child_profile where app_user_id = $1", [child.rows[0].app_user_id]);
  ids.childProfile = profile.rows[0].id;

  const subj = await db.query("select id from public.subjects where owner_family_id = $1 and code = 'math'", [ids.family]);
  ids.subject = subj.rows[0].id;
  const topic = await db.query(
    "insert into public.topics (owner_family_id, subject_id, title, sort_order) values ($1, $2, 'Дроби', 0) returning id",
    [ids.family, ids.subject],
  );
  ids.topic = topic.rows[0].id;

  const item = await db.query(
    `insert into public.library_items (owner_family_id, subject_id, topic_id, title, status, pedagogy, child_feedback)
     values ($1, $2, $3, 'Блок: Дроби', 'active', $4::jsonb, $5::jsonb) returning id`,
    [
      ids.family,
      ids.subject,
      ids.topic,
      JSON.stringify({ goalUk: "мета", hookUk: "гачок", visibleOutcomeUk: "результат", techniques: [], misconceptionsUk: [], comprehensionChecksUk: [], reviewStatus: "first_pass" }),
      JSON.stringify({ interesting: 0, normal: 0, boring: 0 }),
    ],
  );
  ids.libraryItem = item.rows[0].id;

  const other = await db.query("insert into public.families (timezone, locale) values ('Europe/Kyiv', 'uk') returning id");
  ids.otherFamily = other.rows[0].id;
});

afterAll(async () => {
  await db.query("delete from public.families where id in ($1, $2)", [ids.family, ids.otherFamily]);
  await db.end();
});

describe("library_items: needs_review status + pedagogy/child_feedback columns", () => {
  it("accepts 'needs_review' (ADR-022 step 5) and defaults pedagogy/child_feedback to '{}'/counters", async () => {
    const inserted = await db.query(
      `insert into public.library_items (owner_family_id, subject_id, topic_id, title, status)
       values ($1, $2, $3, 'Заблокований блок', 'needs_review') returning status, pedagogy, child_feedback`,
      [ids.family, ids.subject, ids.topic],
    );
    expect(inserted.rows[0].status).toBe("needs_review");
    expect(inserted.rows[0].child_feedback).toEqual({ interesting: 0, normal: 0, boring: 0 });
  });

  it("still rejects an unknown status value", async () => {
    const code = await serviceErrorCode(
      db,
      `insert into public.library_items (owner_family_id, subject_id, topic_id, title, status) values ($1, $2, $3, 'X', 'bogus')`,
      [ids.family, ids.subject, ids.topic],
    );
    expect(code).toBe("23514"); // check_violation
  });

  it("a needs_review block stays invisible to the child (same policy as S3, re-checked after the status extension)", async () => {
    const needsReview = await db.query(
      `insert into public.library_items (owner_family_id, subject_id, topic_id, title, status) values ($1, $2, $3, 'Прихований блок', 'needs_review') returning id`,
      [ids.family, ids.subject, ids.topic],
    );
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      const rows = await db.query("select id from public.library_items where id = $1", [needsReview.rows[0].id]);
      expect(rows.rowCount).toBe(0);
    });
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      const rows = await db.query("select id from public.library_items where id = $1", [needsReview.rows[0].id]);
      expect(rows.rowCount).toBe(1);
    });
  });
});

describe("library_item_reviews (ADR-022, US-6.11 КП-3/6): RLS", () => {
  it("the parent can read a block's review history", async () => {
    await db.query(
      `insert into public.library_item_reviews (owner_family_id, library_item_id, iteration, provider, model, verdict, scores, notes)
       values ($1, $2, 1, 'openai', 'gpt-5.6-sol', 'approved', '{"safety": 2}'::jsonb, 'ok')`,
      [ids.family, ids.libraryItem],
    );
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      const rows = await db.query("select id, verdict from public.library_item_reviews where library_item_id = $1", [ids.libraryItem]);
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].verdict).toBe("approved");
    });
  });

  it("the child cannot read review history (US-6.10 КП-4: the passport detail is never shown to the child)", async () => {
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      const rows = await db.query("select id from public.library_item_reviews where library_item_id = $1", [ids.libraryItem]);
      expect(rows.rowCount).toBe(0);
    });
  });

  it("another family's parent cannot read this family's review history", async () => {
    const otherParentAuth = await createAuthUser(db, "s3b.other.parent@example.com");
    await db.query("insert into public.app_users (auth_user_id, family_id, role) values ($1, $2, 'parent')", [otherParentAuth, ids.otherFamily]);
    await db.query("insert into public.parent_settings (family_id) values ($1)", [ids.otherFamily]);
    await asRole(db, { role: "authenticated", sub: otherParentAuth }, async () => {
      const rows = await db.query("select id from public.library_item_reviews where library_item_id = $1", [ids.libraryItem]);
      expect(rows.rowCount).toBe(0);
    });
  });

  it("rejects a second review row for the same (library_item_id, iteration)", async () => {
    const code = await serviceErrorCode(
      db,
      `insert into public.library_item_reviews (owner_family_id, library_item_id, iteration, provider, model, verdict)
       values ($1, $2, 1, 'openai', 'gpt-5.6-sol', 'approved')`,
      [ids.family, ids.libraryItem],
    );
    expect(code).toBe("23505"); // unique_violation
  });

  it("no direct client writes: authenticated cannot insert a review even for her own family", async () => {
    const code = await asRole(db, { role: "authenticated", sub: ids.parentAuth }, () =>
      errorCode(
        db,
        `insert into public.library_item_reviews (owner_family_id, library_item_id, iteration, provider, model, verdict)
         values ($1, $2, 2, 'openai', 'gpt-5.6-sol', 'approved')`,
        [ids.family, ids.libraryItem],
      ),
    );
    expect(code).toBe("42501"); // insufficient_privilege
  });
});

describe("model routes for the pipeline (ADR-005, ADR-022)", () => {
  it("seeds lesson_planning (Claude) and lesson_review (OpenAI — a DIFFERENT provider, US-6.11 КП-1)", async () => {
    const { rows } = await db.query(
      "select role, primary_provider, primary_model from public.model_routes where family_id = $1 and role in ('lesson_planning', 'lesson_review') order by role",
      [ids.family],
    );
    expect(rows).toEqual([
      { role: "lesson_planning", primary_provider: "anthropic", primary_model: "claude-opus-5-5" },
      { role: "lesson_review", primary_provider: "openai", primary_model: "gpt-5.6-sol" },
    ]);
  });
});
