/**
 * S31 database tests (E-22, US-22.1..22.3, ADR-030): the 9 new SECURITY
 * DEFINER RPCs for parent-managed subjects/courses/course groups.
 *
 * Two things are checked, matching the ADR's two-layer gate:
 *   1. Grants — none of these RPCs are callable by `anon`/`authenticated`
 *      (the real "parent only" gate is `requireParentAccess()` in the server
 *      action; the RPC itself must be unreachable to any client role).
 *   2. RPC logic — duplicate-name rejection scoped per `kind`/per group, and
 *      cross-family isolation (a family's id never lets it touch another
 *      family's row, even if it guesses a valid uuid).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asRole, connect, createAuthUser, errorCode } from "./helpers";

let db: pg.Client;
let familyA: string;
let familyB: string;
let strangerAuth: string;

beforeAll(async () => {
  db = connect();
  await db.connect();
  const { rows: a } = await db.query("insert into public.families (timezone, locale) values ('UTC', 'uk') returning id");
  familyA = a[0].id;
  const { rows: b } = await db.query("insert into public.families (timezone, locale) values ('UTC', 'uk') returning id");
  familyB = b[0].id;
  strangerAuth = await createAuthUser(db, "s31-stranger@example.com");
});

afterAll(async () => {
  await db.query("delete from public.families where id in ($1, $2)", [familyA, familyB]);
  await db.end();
});

/**
 * `errorCode` (helpers.ts) uses a savepoint, which requires an already-open
 * transaction (the `asRole` cases below open one). Outside of that, each
 * statement here is its own implicit transaction, so a bare try/catch is
 * enough — no savepoint/rollback needed to keep going.
 */
async function code(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
}

const NIL = "'00000000-0000-0000-0000-000000000000'::uuid";
const RPC_CALLS: Array<[string, string]> = [
  ["add_subject", `select * from public.add_subject(${NIL}, 'x')`],
  ["rename_subject", `select public.rename_subject(${NIL}, ${NIL}, 'x')`],
  ["set_subject_active", `select public.set_subject_active(${NIL}, ${NIL}, true)`],
  ["add_course", `select * from public.add_course(${NIL}, 'x')`],
  ["update_course", `select public.update_course(${NIL}, ${NIL}, 'x')`],
  ["add_course_group", `select public.add_course_group(${NIL}, 'x')`],
  ["rename_course_group", `select public.rename_course_group(${NIL}, ${NIL}, 'x')`],
  ["set_course_group_active", `select public.set_course_group_active(${NIL}, ${NIL}, true)`],
  ["slugify_subject_code", `select public.slugify_subject_code(${NIL}, 'x')`],
];

describe("S31 RPC grants: service_role only, never anon/authenticated", () => {
  for (const [fnName, sql] of RPC_CALLS) {
    it(`anon cannot call ${fnName}`, async () => {
      await asRole(db, { role: "anon" }, async () => {
        expect(await code(sql)).toBe("42501");
      });
    });
    it(`authenticated cannot call ${fnName}`, async () => {
      await asRole(db, { role: "authenticated", sub: strangerAuth }, async () => {
        expect(await code(sql)).toBe("42501");
      });
    });
  }
});

describe("add_subject / rename_subject / set_subject_active (US-22.1)", () => {
  it("creates a school subject, inactive by default", async () => {
    const { rows } = await db.query("select * from public.add_subject($1, $2)", [familyA, "Інформатика"]);
    expect(rows).toHaveLength(1);
    const { rows: subj } = await db.query("select kind, active, is_stub, code from public.subjects where id = $1", [rows[0].out_id]);
    expect(subj[0]).toMatchObject({ kind: "school_subject", active: false, is_stub: false });
    expect(subj[0].code).toBe(rows[0].out_code);
  });

  it("rejects a duplicate school-subject name, case/whitespace-insensitive (КП-2 US-22.1)", async () => {
    await db.query("select * from public.add_subject($1, $2)", [familyA, "Хімія"]);
    expect(await code("select * from public.add_subject($1, $2)", [familyA, "  хімія  "])).toBe("P0011");
  });

  it("allows a course with the same name as a school subject (separate kind-scoped check, КП-2 US-22.2)", async () => {
    await db.query("select * from public.add_subject($1, $2)", [familyA, "Географія"]);
    const { rows } = await db.query("select * from public.add_course($1, $2)", [familyA, "Географія"]);
    expect(rows).toHaveLength(1);
  });

  it("rejects an empty/too-long name", async () => {
    expect(await code("select * from public.add_subject($1, $2)", [familyA, "   "])).toBe("P0010");
    expect(await code("select * from public.add_subject($1, $2)", [familyA, "x".repeat(121)])).toBe("P0010");
  });

  it("rename_subject rejects a duplicate within the same kind, but not not-found ids from another family", async () => {
    const { rows: s1 } = await db.query("select * from public.add_subject($1, $2)", [familyA, "Фізика"]);
    const { rows: s2 } = await db.query("select * from public.add_subject($1, $2)", [familyA, "Астрономія"]);
    expect(await code("select public.rename_subject($1, $2, $3)", [familyA, s2[0].out_id, "фізика"])).toBe("P0011");

    // Cross-family isolation: familyB cannot rename familyA's subject even
    // knowing its real id.
    expect(await code("select public.rename_subject($1, $2, $3)", [familyB, s1[0].out_id, "Хакнуто"])).toBe(
      "P0002",
    );
    const { rows: unchanged } = await db.query("select name_uk from public.subjects where id = $1", [s1[0].out_id]);
    expect(unchanged[0].name_uk).toBe("Фізика");
  });

  it("set_subject_active toggles active, and cannot be used cross-family", async () => {
    const { rows } = await db.query("select * from public.add_subject($1, $2)", [familyA, "Біологія"]);
    await db.query("select public.set_subject_active($1, $2, $3)", [familyA, rows[0].out_id, true]);
    const { rows: on } = await db.query("select active from public.subjects where id = $1", [rows[0].out_id]);
    expect(on[0].active).toBe(true);

    expect(await code("select public.set_subject_active($1, $2, $3)", [familyB, rows[0].out_id, false])).toBe(
      "P0002",
    );
    const { rows: stillOn } = await db.query("select active from public.subjects where id = $1", [rows[0].out_id]);
    expect(stillOn[0].active).toBe(true);
  });
});

describe("add_course_group / add_course / update_course (US-22.2, US-22.3)", () => {
  it("creates a course group, inactive by default, with duplicate-name rejection", async () => {
    const { rows } = await db.query("select public.add_course_group($1, $2) as id", [familyA, "Група ІТ"]);
    const groupId = rows[0].id;
    const { rows: g } = await db.query("select active from public.course_groups where id = $1", [groupId]);
    expect(g[0].active).toBe(false);
    expect(await code("select public.add_course_group($1, $2)", [familyA, " група іт "])).toBe("P0011");
  });

  it("add_course sets kind='course', config.requires_diagnostic=false, and rejects an unowned group_id", async () => {
    const { rows: grp } = await db.query("select public.add_course_group($1, $2) as id", [familyA, "Група Мов"]);
    const { rows } = await db.query("select * from public.add_course($1, $2, $3)", [familyA, "Промт-інжиніринг", grp[0].id]);
    const { rows: subj } = await db.query("select kind, group_id, config from public.subjects where id = $1", [rows[0].out_id]);
    expect(subj[0]).toMatchObject({ kind: "course", group_id: grp[0].id });
    expect(subj[0].config.requires_diagnostic).toBe(false);

    // A group belonging to another family cannot be attached (P0012).
    const { rows: otherGrp } = await db.query("select public.add_course_group($1, $2) as id", [familyB, "Чужа група"]);
    expect(await code("select * from public.add_course($1, $2, $3)", [familyA, "Інший курс", otherGrp[0].id])).toBe(
      "P0012",
    );
  });

  it("rejects a duplicate course name scoped to courses only", async () => {
    await db.query("select * from public.add_course($1, $2)", [familyA, "Основи Python"]);
    expect(await code("select * from public.add_course($1, $2)", [familyA, "основи python"])).toBe("P0011");
  });

  it("update_course renames and re-groups an existing course, rejecting a foreign subject id", async () => {
    const { rows: course } = await db.query("select * from public.add_course($1, $2)", [familyA, "Robotics"]);
    const { rows: grp } = await db.query("select public.add_course_group($1, $2) as id", [familyA, "Група Робо"]);
    await db.query("select public.update_course($1, $2, $3, $4)", [familyA, course[0].out_id, "Robotics 101", grp[0].id]);
    const { rows: updated } = await db.query("select name_uk, group_id from public.subjects where id = $1", [
      course[0].out_id,
    ]);
    expect(updated[0]).toMatchObject({ name_uk: "Robotics 101", group_id: grp[0].id });

    expect(
      await code("select public.update_course($1, $2, $3)", [familyB, course[0].out_id, "Захоплено"]),
    ).toBe("P0002");
  });

  it("rename_course_group / set_course_group_active follow the same isolation and duplicate rules", async () => {
    const { rows: g1 } = await db.query("select public.add_course_group($1, $2) as id", [familyA, "Група Один"]);
    const { rows: g2 } = await db.query("select public.add_course_group($1, $2) as id", [familyA, "Група Два"]);
    expect(await code("select public.rename_course_group($1, $2, $3)", [familyA, g2[0].id, "група один"])).toBe(
      "P0011",
    );
    expect(await code("select public.rename_course_group($1, $2, $3)", [familyB, g1[0].id, "Хакнуто"])).toBe(
      "P0002",
    );

    await db.query("select public.set_course_group_active($1, $2, $3)", [familyA, g1[0].id, true]);
    const { rows: active } = await db.query("select active from public.course_groups where id = $1", [g1[0].id]);
    expect(active[0].active).toBe(true);
    expect(await code("select public.set_course_group_active($1, $2, $3)", [familyB, g1[0].id, false])).toBe(
      "P0002",
    );
  });
});

describe("unique indexes back the duplicate-name rules at the schema level", () => {
  it("subjects_owner_kind_name_uidx rejects a raw duplicate insert within the same kind, but allows across kinds", async () => {
    await db.query("begin");
    try {
      await db.query(
        "insert into public.subjects (owner_family_id, code, name_uk, kind) values ($1, 'dup_a', 'Дублікат', 'school_subject')",
        [familyA],
      );
      expect(
        await errorCode(
          db,
          "insert into public.subjects (owner_family_id, code, name_uk, kind) values ($1, 'dup_b', ' дублікат ', 'school_subject')",
          [familyA],
        ),
      ).toBe("23505");
      // Same name, different kind -> allowed.
      expect(
        await errorCode(
          db,
          "insert into public.subjects (owner_family_id, code, name_uk, kind) values ($1, 'dup_c', 'Дублікат', 'course')",
          [familyA],
        ),
      ).toBeNull();
    } finally {
      await db.query("rollback");
    }
  });

  it("course_groups_owner_name_uidx rejects a raw duplicate insert", async () => {
    await db.query("begin");
    try {
      await db.query("insert into public.course_groups (owner_family_id, name_uk) values ($1, 'Дубль')", [familyA]);
      expect(
        await errorCode(db, "insert into public.course_groups (owner_family_id, name_uk) values ($1, ' дубль ')", [
          familyA,
        ]),
      ).toBe("23505");
    } finally {
      await db.query("rollback");
    }
  });

  it("subjects.kind rejects any value outside the two allowed", async () => {
    await db.query("begin");
    expect(
      await errorCode(
        db,
        "insert into public.subjects (owner_family_id, code, name_uk, kind) values ($1, 'bad_kind', 'x', 'other')",
        [familyA],
      ),
    ).toBe("23514");
    await db.query("rollback");
  });
});
