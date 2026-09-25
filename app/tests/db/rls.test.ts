/**
 * RLS & tenancy tests (NFR-PRIV-4, US-1.2 KP-2, ADR-018 K-2, ADR-021).
 * Runs on an ephemeral PostgreSQL with a Supabase shim: `npm run test:db`.
 * All identities are placeholders (example.com) — no real personal data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asRole, connect, createAuthUser, defaults, errorCode } from "./helpers";

let db: pg.Client;
const ids = {} as {
  parentAuth: string;
  childAuth: string;
  strangerAuth: string;
  family: string;
  childAppUser: string;
  childProfile: string;
  otherParentAuth: string;
  otherFamily: string;
};

const FAMILY_TABLES = [
  "app_users",
  "parent_settings",
  "child_profile",
  "tutor_voices",
  "persona_changes",
  "notifications",
  "learning_modules",
  "academic_years",
] as const;

beforeAll(async () => {
  db = connect();
  await db.connect();

  ids.parentAuth = await createAuthUser(db, "parent.placeholder@example.com");
  ids.childAuth = await createAuthUser(db, "child.placeholder@example.com");
  ids.strangerAuth = await createAuthUser(db, "stranger@example.com");

  const parent = await db.query("select * from public.register_app_user($1, 'parent', $2)", [
    ids.parentAuth,
    JSON.stringify(defaults),
  ]);
  const child = await db.query("select * from public.register_app_user($1, 'child', $2)", [
    ids.childAuth,
    JSON.stringify(defaults),
  ]);
  ids.family = parent.rows[0].family_id;
  ids.childAppUser = child.rows[0].app_user_id;
  const profile = await db.query("select id from public.child_profile where app_user_id = $1", [ids.childAppUser]);
  ids.childProfile = profile.rows[0].id;

  // Seed some parent-only data for the first family.
  await db.query("update public.parent_settings set pin_hash = '$argon2id$placeholder' where family_id = $1", [
    ids.family,
  ]);
  await db.query(
    "insert into public.notifications (family_id, type, payload) values ($1, 'nickname_changed', '{\"nickname\":\"Зірочка\"}')",
    [ids.family],
  );
  await db.query(
    "insert into public.persona_changes (family_id, child_profile_id, field, new_value, changed_by) values ($1, $2, 'name', 'Ліра', 'child')",
    [ids.family, ids.childProfile],
  );
  await db.query(
    `insert into public.tutor_voices (family_id, provider_voice_id, gender, label_uk, status)
     values ($1, 'voice-a', 'f', 'Тепла', 'active'), ($1, 'voice-b', 'm', 'Дружній', 'disabled')`,
    [ids.family],
  );

  // A second family created directly (future multi-family case, ADR-018).
  const other = await db.query(
    "insert into public.families (timezone, locale) values ('Europe/Kyiv', 'uk') returning id",
  );
  ids.otherFamily = other.rows[0].id;
  ids.otherParentAuth = await createAuthUser(db, "other.parent@example.com");
  await db.query("insert into public.app_users (auth_user_id, family_id, role) values ($1, $2, 'parent')", [
    ids.otherParentAuth,
    ids.otherFamily,
  ]);
  await db.query("insert into public.parent_settings (family_id) values ($1)", [ids.otherFamily]);
  await db.query("insert into public.notifications (family_id, type) values ($1, 'other_family_event')", [
    ids.otherFamily,
  ]);
  await db.query(
    "insert into public.subjects (owner_family_id, code, name_uk) values ($1, 'other_subject', 'Чужий предмет')",
    [ids.otherFamily],
  );
});

afterAll(async () => {
  await db?.end();
});

const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows.length);

describe("register_app_user (server-only bootstrap)", () => {
  it("creates exactly one family with defaults from config", async () => {
    const families = await db.query("select * from public.families where id = $1", [ids.family]);
    expect(families.rows[0]).toMatchObject({ timezone: defaults.timezone, locale: defaults.locale });
    const subjects = await db.query(
      "select code, is_stub, active from public.subjects where owner_family_id = $1 order by sort_order",
      [ids.family],
    );
    expect(subjects.rows.map((r) => r.code)).toEqual(defaults.subjects.map((s) => s.code));
    expect(subjects.rows.filter((r) => r.is_stub)).toHaveLength(2);
    expect(subjects.rows.filter((r) => !r.is_stub)).toHaveLength(8);
    expect(subjects.rows.every((r) => r.active === false)).toBe(true);
    const modules = await db.query("select code from public.learning_modules where family_id = $1", [ids.family]);
    expect(modules.rows).toEqual([{ code: "school" }]);
    const years = await db.query("select label, grade, status from public.academic_years where family_id = $1", [
      ids.family,
    ]);
    expect(years.rows).toEqual([
      { label: defaults.academicYear.label, grade: defaults.academicYear.grade, status: "active" },
    ]);
  });

  it("is idempotent and joins the existing family", async () => {
    const again = await db.query("select * from public.register_app_user($1, 'child', $2)", [
      ids.childAuth,
      JSON.stringify(defaults),
    ]);
    expect(again.rows[0]).toMatchObject({ app_user_id: ids.childAppUser, family_id: ids.family, role: "child" });
    expect(await count("select 1 from public.child_profile where app_user_id = $1", [ids.childAppUser])).toBe(1);
  });

  it("rejects invalid roles", async () => {
    await db.query("begin");
    expect(
      await errorCode(db, "select * from public.register_app_user($1, 'admin', '{}')", [ids.strangerAuth]),
    ).toBe("22023");
    await db.query("rollback");
  });

  it("cannot be called by API roles", async () => {
    for (const who of [{ role: "anon" as const }, { role: "authenticated" as const, sub: ids.childAuth }]) {
      await asRole(db, who, async () => {
        expect(
          await errorCode(db, "select * from public.register_app_user($1, 'parent', '{}')", [ids.childAuth]),
        ).toBe("42501");
      });
    }
  });
});

describe("RLS: role separation (NFR-PRIV-4, US-1.2 KP-2)", () => {
  it("anon sees nothing", async () => {
    await asRole(db, { role: "anon" }, async () => {
      for (const t of [...FAMILY_TABLES, "families", "subjects"]) {
        expect(await errorCode(db, `select * from public.${t}`)).toBe("42501");
      }
    });
  });

  it("an authenticated but unregistered (non-allowlisted) user sees no rows", async () => {
    await asRole(db, { role: "authenticated", sub: ids.strangerAuth }, async () => {
      for (const t of ["families", "app_users", "child_profile", "subjects", "academic_years", "learning_modules"]) {
        expect(await count(`select * from public.${t}`)).toBe(0);
      }
    });
  });

  it("the child cannot read parent-only tables", async () => {
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      expect(await count("select family_id from public.parent_settings")).toBe(0);
      expect(await count("select * from public.notifications")).toBe(0);
      expect(await count("select * from public.persona_changes")).toBe(0);
    });
  });

  it("the child sees only her own profile and user row", async () => {
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      const users = await db.query("select role from public.app_users");
      expect(users.rows).toEqual([{ role: "child" }]);
      const profiles = await db.query("select id from public.child_profile");
      expect(profiles.rows).toEqual([{ id: ids.childProfile }]);
    });
  });

  it("the child sees subjects, modules and the academic year of her family, and only active voices", async () => {
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      expect(await count("select * from public.subjects")).toBe(defaults.subjects.length);
      expect(await count("select * from public.learning_modules")).toBe(1);
      expect(await count("select * from public.academic_years")).toBe(1);
      const voices = await db.query("select provider_voice_id from public.tutor_voices");
      expect(voices.rows).toEqual([{ provider_voice_id: "voice-a" }]);
    });
  });

  it("the parent reads the whole family", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      expect(await count("select * from public.app_users")).toBe(2);
      expect(await count("select * from public.child_profile")).toBe(1);
      expect(await count("select * from public.notifications")).toBe(1);
      expect(await count("select * from public.persona_changes")).toBe(1);
      expect(await count("select * from public.tutor_voices")).toBe(2);
      expect(await count("select family_id, pin_failed from public.parent_settings")).toBe(1);
    });
  });

  it("the PIN hash is not readable through the API, even by the parent (NFR-PRIV-9)", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      expect(await errorCode(db, "select pin_hash from public.parent_settings")).toBe("42501");
      expect(await errorCode(db, "select * from public.parent_settings")).toBe("42501");
    });
  });
});

describe("RLS: no direct writes from browsers", () => {
  const writes: Array<[string, (i: typeof ids) => [string, unknown[]]]> = [
    ["update own child_profile", (i) => ["update public.child_profile set nickname = 'Хакер' where id = $1", [i.childProfile]]],
    ["insert notification", (i) => ["insert into public.notifications (family_id, type) values ($1, 'x')", [i.family]]],
    ["update parent_settings", (i) => ["update public.parent_settings set pin_failed = 0 where family_id = $1", [i.family]]],
    ["escalate own role", (i) => ["update public.app_users set role = 'parent' where auth_user_id = $1", [i.childAuth]]],
    ["insert app_user", (i) => ["insert into public.app_users (auth_user_id, family_id, role) values ($1, $2, 'parent')", [i.strangerAuth, i.family]]],
    ["delete subjects", () => ["delete from public.subjects", []]],
  ];

  for (const sub of ["childAuth", "parentAuth"] as const) {
    for (const [name, build] of writes) {
      it(`${sub === "childAuth" ? "child" : "parent"} cannot ${name}`, async () => {
        await asRole(db, { role: "authenticated", sub: ids[sub] }, async () => {
          const [sql, params] = build(ids);
          expect(await errorCode(db, sql, params)).toBe("42501");
        });
      });
    }
  }
});

describe("RLS: family isolation (ADR-018 K-2)", () => {
  it("data of another family is invisible", async () => {
    await asRole(db, { role: "authenticated", sub: ids.otherParentAuth }, async () => {
      const families = await db.query("select id from public.families");
      expect(families.rows).toEqual([{ id: ids.otherFamily }]);
      expect(await count("select * from public.app_users")).toBe(1);
      expect(await count("select * from public.child_profile")).toBe(0);
      const notes = await db.query("select type from public.notifications");
      expect(notes.rows).toEqual([{ type: "other_family_event" }]);
      const subjects = await db.query("select code from public.subjects");
      expect(subjects.rows).toEqual([{ code: "other_subject" }]);
      expect(await count("select * from public.academic_years")).toBe(0);
    });
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      expect(await count("select * from public.notifications where type = 'other_family_event'")).toBe(0);
      expect(await count("select * from public.subjects where code = 'other_subject'")).toBe(0);
    });
  });

  it("every family table has RLS enabled and a family_id column", async () => {
    const { rows } = await db.query(
      `select c.relname, c.relrowsecurity,
              exists (select 1 from information_schema.columns col
                       where col.table_schema = 'public' and col.table_name = c.relname
                         and col.column_name in ('family_id', 'owner_family_id')) as has_family
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} must have RLS`).toBe(true);
      if (r.relname !== "families") expect(r.has_family, `${r.relname} must carry family_id`).toBe(true);
    }
  });
});

describe("Google profile scrubbing (NFR-PRIV-11)", () => {
  it("removes name and photo from auth metadata on insert and update", async () => {
    const id = await createAuthUser(db, "scrub@example.com", {
      name: "Real Name",
      full_name: "Real Name",
      given_name: "Real",
      family_name: "Name",
      picture: "https://example.com/p.png",
      avatar_url: "https://example.com/p.png",
      email: "scrub@example.com",
      sub: "google-sub",
    });
    const u = await db.query("select raw_user_meta_data from auth.users where id = $1", [id]);
    expect(u.rows[0].raw_user_meta_data).toEqual({ email: "scrub@example.com", sub: "google-sub" });

    await db.query(
      `update auth.users set raw_user_meta_data = raw_user_meta_data || '{"name":"Again","picture":"x"}' where id = $1`,
      [id],
    );
    const u2 = await db.query("select raw_user_meta_data from auth.users where id = $1", [id]);
    expect(u2.rows[0].raw_user_meta_data).toEqual({ email: "scrub@example.com", sub: "google-sub" });

    await db.query(
      `insert into auth.identities (user_id, provider, identity_data)
       values ($1, 'google', '{"name":"Real Name","picture":"x","email":"scrub@example.com"}')`,
      [id],
    );
    const ident = await db.query("select identity_data from auth.identities where user_id = $1", [id]);
    expect(ident.rows[0].identity_data).toEqual({ email: "scrub@example.com" });
  });

  it("app_users has no name, e-mail or photo columns", async () => {
    const { rows } = await db.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'app_users'",
    );
    const cols = rows.map((r) => r.column_name);
    for (const forbidden of ["name", "email", "full_name", "picture", "avatar_url"]) {
      expect(cols).not.toContain(forbidden);
    }
  });
});

describe("Academic years as data (ADR-021, NFR-PLAT-7)", () => {
  it("allows only one active year per family", async () => {
    await db.query("begin");
    expect(
      await errorCode(
        db,
        "insert into public.academic_years (family_id, label, grade, starts_on, ends_on) values ($1, 'next', 7, '2027-09-01', '2028-08-31')",
        [ids.family],
      ),
    ).toBe("23505");
    await db.query("rollback");
  });

  it("set_default_academic_year fills academic_year_id from the active year", async () => {
    await db.query("begin");
    try {
      await db.query(
        `create temp table demo_sessions (id serial, family_id uuid not null, academic_year_id uuid)`,
      );
      await db.query(
        `create trigger demo_year before insert on demo_sessions for each row execute function public.set_default_academic_year()`,
      );
      await db.query("insert into demo_sessions (family_id) values ($1)", [ids.family]);
      const active = await db.query("select id from public.academic_years where family_id = $1 and status = 'active'", [
        ids.family,
      ]);
      const row = await db.query("select academic_year_id from demo_sessions");
      expect(row.rows[0].academic_year_id).toBe(active.rows[0].id);
      // A second year can be added purely as data once the first is archived.
      await db.query("update public.academic_years set status = 'archived' where family_id = $1", [ids.family]);
      await db.query(
        "insert into public.academic_years (family_id, label, grade, starts_on, ends_on) values ($1, 'next', 7, '2027-09-01', '2028-08-31')",
        [ids.family],
      );
      await db.query("insert into demo_sessions (family_id) values ($1)", [ids.family]);
      const rows = await db.query("select distinct academic_year_id from demo_sessions");
      expect(rows.rows).toHaveLength(2);
      expect(
        await errorCode(db, "insert into demo_sessions (family_id) values ($1)", [ids.otherFamily]),
      ).toBe("P0001");
    } finally {
      await db.query("rollback");
    }
  });
});
