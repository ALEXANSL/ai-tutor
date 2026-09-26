/**
 * S1b database tests: scanned-book OCR (D-54) — the new `ocr_page` model
 * route, the `materials` OCR bookkeeping columns and `scan_awaiting_ocr`
 * status, `parent_settings.ocr_confirm_above_pages`, and RLS of
 * `material_ocr_pages`. Ephemeral PostgreSQL + pgvector (`npm run test:db`).
 * Placeholder data only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asRole, connect, createAuthUser, errorCode } from "./helpers";

let db: pg.Client;
const ids = {} as {
  family: string;
  otherFamily: string;
  parentAuth: string;
  childAuth: string;
  otherParentAuth: string;
  scan: string;
  scanOtherFamily: string;
};

const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows.length);

async function makeFamily(): Promise<string> {
  const { rows } = await db.query("insert into public.families (timezone, locale) values ('UTC', 'uk') returning id");
  await db.query("insert into public.parent_settings (family_id, monthly_limit_usd) values ($1, 10)", [rows[0].id]);
  return rows[0].id;
}

async function addUser(family: string, role: "parent" | "child", email: string): Promise<string> {
  const auth = await createAuthUser(db, email);
  await db.query("insert into public.app_users (auth_user_id, family_id, role) values ($1, $2, $3)", [auth, family, role]);
  return auth;
}

async function addMaterial(family: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = ["owner_family_id", "drive_file_id", "name", "mime", "format", "kind", "status", ...Object.keys(extra)];
  const vals = [family, `drive-${family}`, "Скан.pdf", "application/pdf", "pdf", "textbook", "scan_awaiting_ocr", ...Object.values(extra)];
  const { rows } = await db.query(
    `insert into public.materials (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    vals,
  );
  return rows[0].id;
}

beforeAll(async () => {
  db = connect();
  await db.connect();
  ids.family = await makeFamily();
  ids.otherFamily = await makeFamily();
  ids.parentAuth = await addUser(ids.family, "parent", "s1b.parent@example.com");
  ids.childAuth = await addUser(ids.family, "child", "s1b.child@example.com");
  ids.otherParentAuth = await addUser(ids.otherFamily, "parent", "s1b.other@example.com");

  ids.scan = await addMaterial(ids.family, { ocr_pages_total: 40, ocr_estimated_cost_usd: 1.2345 });
  ids.scanOtherFamily = await addMaterial(ids.otherFamily);

  await db.query(
    "insert into public.material_ocr_pages (owner_family_id, material_id, page, status, text) values ($1, $2, 1, 'done', 'Розпізнаний текст сторінки 1.')",
    [ids.family, ids.scan],
  );
  await db.query(
    "insert into public.material_ocr_pages (owner_family_id, material_id, page, status) values ($1, $2, 2, 'pending')",
    [ids.family, ids.scan],
  );
  await db.query(
    "insert into public.material_ocr_pages (owner_family_id, material_id, page, status) values ($1, $2, 1, 'pending')",
    [ids.otherFamily, ids.scanOtherFamily],
  );
});

afterAll(async () => {
  await db?.query("delete from public.families where id = any($1)", [[ids.family, ids.otherFamily]]);
  await db?.end();
});

describe("model route ocr_page (D-54, ADR-005 note)", () => {
  it("is seeded for every family, budget-deferred, Anthropic Sonnet 5", async () => {
    const { rows } = await db.query(
      "select primary_provider, primary_model, params->>'budget_policy' as policy from public.model_routes where family_id = $1 and role = 'ocr_page'",
      [ids.family],
    );
    expect(rows).toEqual([{ primary_provider: "anthropic", primary_model: "claude-sonnet-5", policy: "defer" }]);
  });

  it("has a price row (reuses claude-sonnet-5 from the S1 seed)", async () => {
    const { rows } = await db.query("select 1 from public.model_prices where provider = 'anthropic' and model = 'claude-sonnet-5'");
    expect(rows).toHaveLength(1);
  });
});

describe("materials: OCR columns and scan_awaiting_ocr status", () => {
  it("accepts the new status and stores the estimate/page count", async () => {
    const { rows } = await db.query(
      "select status, ocr_pages_total, ocr_estimated_cost_usd, ocr_pages_done, ocr_confirmed_at from public.materials where id = $1",
      [ids.scan],
    );
    expect(rows[0]).toMatchObject({ status: "scan_awaiting_ocr", ocr_pages_total: 40, ocr_pages_done: 0, ocr_confirmed_at: null });
    expect(Number(rows[0].ocr_estimated_cost_usd)).toBeCloseTo(1.2345, 4);
  });

  it("still rejects an unknown status (constraint still enforced after S1b)", async () => {
    await db.query("begin");
    expect(await errorCode(db, "update public.materials set status = 'not_a_status' where id = $1", [ids.scan])).toBe("23514");
    await db.query("rollback");
  });

  it("defaults parent_settings.ocr_confirm_above_pages to 20", async () => {
    const { rows } = await db.query("select ocr_confirm_above_pages from public.parent_settings where family_id = $1", [ids.family]);
    expect(rows[0].ocr_confirm_above_pages).toBe(20);
  });
});

describe("RLS: material_ocr_pages (parent-only read, server-only write)", () => {
  it("the parent sees only her family's OCR pages", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      const rows = (await db.query("select page, status, text from public.material_ocr_pages order by page")).rows;
      expect(rows).toEqual([
        { page: 1, status: "done", text: "Розпізнаний текст сторінки 1." },
        { page: 2, status: "pending", text: "" },
      ]);
    });
  });

  it("the child and another family see nothing", async () => {
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      expect(await count("select * from public.material_ocr_pages")).toBe(0);
    });
    await asRole(db, { role: "authenticated", sub: ids.otherParentAuth }, async () => {
      const rows = (await db.query("select page from public.material_ocr_pages")).rows;
      expect(rows).toEqual([{ page: 1 }]);
    });
  });

  it("anon sees nothing and cannot write directly from the client", async () => {
    await asRole(db, { role: "anon" }, async () => {
      expect(await errorCode(db, "select * from public.material_ocr_pages")).toBe("42501");
    });
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      expect(
        await errorCode(db, "insert into public.material_ocr_pages (owner_family_id, material_id, page) values ($1, $2, 9)", [
          ids.family,
          ids.scan,
        ]),
      ).toBe("42501");
      expect(await errorCode(db, "update public.material_ocr_pages set status = 'done' where material_id = $1", [ids.scan])).toBe(
        "42501",
      );
    });
  });
});
