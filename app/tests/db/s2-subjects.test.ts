/**
 * S2 database tests: "поточна тема" invariant (US-3.1 KP-1).
 *
 * BUG-006 fix: `setCurrentTopicAction` (app/src/app/actions/subjects.ts) now
 * calls a single atomic `security definer` RPC (`public.set_current_topic`,
 * migration `20260927100000_s2_current_topic_atomic.sql`) that clears the
 * old current topic, sets the new one and activates the subject in one
 * transaction. A partial unique index (`topics_one_current_per_subject_idx`
 * on `topics (subject_id) where is_current`) backs the invariant at the
 * schema level regardless of which code path writes to `topics`: this test
 * checks that a second, unmediated `UPDATE` trying to mark a second topic of
 * the same subject as current is rejected by the database itself.
 *
 * See docs/bugs/BUG-006-current-topic-not-atomic.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { connect } from "./helpers";

let db: pg.Client;
let family: string;
let subject: string;
let topicA: string;
let topicB: string;

beforeAll(async () => {
  db = connect();
  await db.connect();
  const { rows: fam } = await db.query("insert into public.families (timezone, locale) values ('UTC', 'uk') returning id");
  family = fam[0].id;
  await db.query("insert into public.parent_settings (family_id, monthly_limit_usd) values ($1, 10)", [family]);
  const { rows: subj } = await db.query(
    "insert into public.subjects (owner_family_id, code, name_uk, sort_order) values ($1, 'math', 'Математика', 0) returning id",
    [family],
  );
  subject = subj[0].id;
  const { rows: t } = await db.query(
    `insert into public.topics (owner_family_id, subject_id, title, sort_order, is_current)
     values ($1, $2, 'Тема A', 0, true), ($1, $2, 'Тема B', 1, false)
     returning id, is_current`,
    [family, subject],
  );
  topicA = t.find((r: { is_current: boolean }) => r.is_current)!.id as unknown as string;
  topicB = t.find((r: { is_current: boolean }) => !r.is_current)!.id as unknown as string;
  // A ready, enabled textbook is required for set_current_topic() to
  // activate the subject (US-3.1 KP-2).
  await db.query(
    `insert into public.materials (owner_family_id, drive_file_id, name, mime, format, kind, subject_id, status, use_in_lessons)
     values ($1, 'drive-file-1', 'Підручник.pdf', 'application/pdf', 'pdf', 'textbook', $2, 'ready', true)`,
    [family, subject],
  );
});

afterAll(async () => {
  await db.query("delete from public.families where id = $1", [family]);
  await db.end();
});

describe("S2 topics.is_current invariant (US-3.1 KP-1)", () => {
  it("BUG-006 fixed: the schema now prevents two topics of the same subject from both being current", async () => {
    // Simulates a partial failure between "clear old current" and "set new
    // current" steps, or a race between two concurrent saves: without the
    // partial unique index, nothing at the DB level would stop topic B from
    // becoming current while topic A is still marked current too. Now the
    // unique index rejects it.
    await expect(db.query("update public.topics set is_current = true where id = $1", [topicB])).rejects.toThrow(
      /duplicate key value violates unique constraint "topics_one_current_per_subject_idx"/,
    );

    const { rows } = await db.query("select id, is_current from public.topics where subject_id = $1 and is_current = true", [subject]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(topicA);
  });

  it("BUG-006 fixed: set_current_topic() atomically clears the old topic, sets the new one and activates the subject", async () => {
    const { rows } = await db.query("select * from public.set_current_topic($1, $2, $3)", [family, subject, topicB]);
    expect(rows).toHaveLength(1);
    expect(rows[0].out_subject_id).toBe(subject);
    expect(rows[0].out_topic_id).toBe(topicB);

    const { rows: current } = await db.query("select id from public.topics where subject_id = $1 and is_current = true", [subject]);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(topicB);

    const { rows: subj } = await db.query("select active from public.subjects where id = $1", [subject]);
    expect(subj[0].active).toBe(true);
  });
});
