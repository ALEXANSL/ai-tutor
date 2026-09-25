/**
 * S2 database tests: "поточна тема" invariant (US-3.1 KP-1).
 *
 * `setCurrentTopicAction` (app/src/app/actions/subjects.ts) enforces "only
 * one current topic per subject" purely in application code, with three
 * sequential (non-transactional) PostgREST calls: clear old current -> set
 * new current -> activate subject. There is no database-level constraint
 * (e.g. a partial unique index) backing that invariant. This test documents
 * the gap: two rows of the same subject can both end up with
 * `is_current = true` at the same time, which the DB schema allows today.
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
});

afterAll(async () => {
  await db.query("delete from public.families where id = $1", [family]);
  await db.end();
});

describe("S2 topics.is_current invariant (US-3.1 KP-1)", () => {
  it("BUG-006: the schema does NOT prevent two topics of the same subject from both being current", async () => {
    // Simulates a partial failure of setCurrentTopicAction between its
    // "clear old current" and "set new current" steps, or a race between two
    // concurrent saves: nothing at the DB level stops topic B from becoming
    // current while topic A is still marked current too.
    await db.query("update public.topics set is_current = true where id = $1", [topicB]);

    const { rows } = await db.query("select id, is_current from public.topics where subject_id = $1 and is_current = true", [subject]);
    // Documents today's (undesired) behaviour: both rows are "current".
    // When BUG-006 is fixed (partial unique index and/or a single atomic
    // RPC), this assertion should start failing loudly — flip it to
    // `toHaveLength(1)` as part of that fix.
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([topicA, topicB].sort());
  });
});
