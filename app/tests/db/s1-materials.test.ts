/**
 * S1 database tests: model routes seed, cost accounting & budget state,
 * jobs queue, hybrid search, chunk structure, RLS of the new tables.
 * Ephemeral PostgreSQL + pgvector (`npm run test:db`). Placeholder data only.
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
  math: string;
  textbook: string;
  book: string;
  disabledBook: string;
  otherMaterial: string;
};

/** A 1536-d vector pointing mostly along `axis` (cosine-friendly fixtures). */
function vec(axis: number, noise = 0): string {
  const v = Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : i === (axis + 1) % 1536 ? noise : 0));
  return JSON.stringify(v);
}

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

async function addMaterial(family: string, name: string, kind: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = ["owner_family_id", "drive_file_id", "name", "mime", "format", "kind", "status", ...Object.keys(extra)];
  const vals = [family, `drive-${name}`, name, "application/pdf", "pdf", kind, "ready", ...Object.values(extra)];
  const { rows } = await db.query(
    `insert into public.materials (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    vals,
  );
  return rows[0].id;
}

async function addChunk(family: string, material: string, ordinal: number, page: number, text: string, embedding: string | null) {
  await db.query(
    `insert into public.chunks (owner_family_id, material_id, ordinal, page, text, embedding, embedding_model)
     values ($1, $2, $3, $4, $5, $6::halfvec, 'text-embedding-3-large')`,
    [family, material, ordinal, page, text, embedding],
  );
}

beforeAll(async () => {
  db = connect();
  await db.connect();
  ids.family = await makeFamily();
  ids.otherFamily = await makeFamily();
  ids.parentAuth = await addUser(ids.family, "parent", "s1.parent@example.com");
  ids.childAuth = await addUser(ids.family, "child", "s1.child@example.com");
  ids.otherParentAuth = await addUser(ids.otherFamily, "parent", "s1.other@example.com");

  const subj = await db.query(
    "insert into public.subjects (owner_family_id, code, name_uk) values ($1, 'math', 'Математика') returning id",
    [ids.family],
  );
  ids.math = subj.rows[0].id;

  ids.textbook = await addMaterial(ids.family, "Математика.pdf", "textbook", { subject_id: ids.math });
  ids.book = await addMaterial(ids.family, "Цікаві дроби.pdf", "popular_science");
  ids.disabledBook = await addMaterial(ids.family, "Вимкнена.pdf", "reference", { use_in_lessons: false });
  ids.otherMaterial = await addMaterial(ids.otherFamily, "Чужа.pdf", "textbook");

  await addChunk(ids.family, ids.textbook, 0, 61, "Щоб додати дроби з різними знаменниками, спершу зводимо їх до спільного знаменника.", vec(1));
  await addChunk(ids.family, ids.textbook, 1, 12, "Відсоток — це сота частина числа.", vec(500));
  await addChunk(ids.family, ids.book, 0, 3, "Історія про піцу: як поділити її на рівні частини — дроби навколо нас.", vec(1, 0.3));
  await addChunk(ids.family, ids.disabledBook, 0, 1, "Таблиця дробів зі спільним знаменником.", vec(1));
  await addChunk(ids.otherFamily, ids.otherMaterial, 0, 1, "Дроби зі спільним знаменником — чужа сім'я.", vec(1));
});

afterAll(async () => {
  // Other test files bootstrap "the first family" (MVP: one family) — leave no trace.
  await db?.query("delete from public.families where id = any($1)", [[ids.family, ids.otherFamily]]);
  await db?.end();
});

describe("model routes (docs/02 7.3, ADR-005)", () => {
  it("are seeded for every new family by trigger", async () => {
    const { rows } = await db.query(
      "select role, primary_provider, primary_model, params->>'budget_policy' as policy from public.model_routes where family_id = $1 order by role",
      [ids.family],
    );
    // S3 (20260928100000) extends the same trigger with lesson_generation,
    // tutor_chat and answer_evaluation (ADR-005); S1b (20260929100000) adds
    // ocr_page (D-54) — still seeded together.
    expect(rows).toEqual([
      { role: "answer_evaluation", primary_provider: "anthropic", primary_model: "claude-sonnet-5", policy: null },
      { role: "embeddings", primary_provider: "openai", primary_model: "text-embedding-3-large", policy: "primary" },
      { role: "indexing_structure", primary_provider: "anthropic", primary_model: "claude-opus-5-5", policy: "defer" },
      { role: "lesson_generation", primary_provider: "anthropic", primary_model: "claude-opus-5-5", policy: null },
      { role: "ocr_page", primary_provider: "anthropic", primary_model: "claude-sonnet-5", policy: "defer" },
      { role: "tutor_chat", primary_provider: "anthropic", primary_model: "claude-sonnet-5", policy: null },
    ]);
  });

  it("have prices for the S1 models", async () => {
    const { rows } = await db.query("select model from public.model_prices order by model");
    expect(rows.map((r) => r.model)).toEqual(expect.arrayContaining(["claude-opus-5-5", "text-embedding-3-large"]));
  });
});

describe("cost accounting (NFR-COST-4, NFR-COST-8, ADR-012)", () => {
  const call = (cost: number, role = "indexing_structure") =>
    JSON.stringify({ role, provider: "anthropic", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 100, cost_usd: cost, ref_table: "materials", ref_id: ids.book });

  it("records the call and increments the month in one step, with state thresholds 80/100/110 %", async () => {
    await db.query("begin");
    try {
      const r1 = await db.query("select * from public.record_ai_call($1, $2::jsonb)", [ids.family, call(7.9)]);
      expect(r1.rows[0]).toMatchObject({ previous_state: "normal", state: "normal" });
      const r2 = await db.query("select * from public.record_ai_call($1, $2::jsonb)", [ids.family, call(0.2)]);
      expect(r2.rows[0]).toMatchObject({ previous_state: "normal", state: "warned" });
      const r3 = await db.query("select * from public.record_ai_call($1, $2::jsonb)", [ids.family, call(2)]);
      expect(r3.rows[0]).toMatchObject({ state: "budget" });
      const r4 = await db.query("select * from public.record_ai_call($1, $2::jsonb)", [ids.family, call(1)]);
      expect(r4.rows[0]).toMatchObject({ state: "hard_stop" });

      const state = await db.query("select * from public.get_budget_state($1)", [ids.family]);
      expect(state.rows[0].state).toBe("hard_stop");
      expect(Number(state.rows[0].spent_usd)).toBeCloseTo(11.1);

      // Safety moderation above the limit is accounted separately (NFR-SAFE-13).
      await db.query("select * from public.record_ai_call($1, $2::jsonb)", [ids.family, call(0.5, "safety_moderator")]);
      const month = await db.query("select spent_usd, safety_over_limit_usd from public.spend_months where family_id = $1", [ids.family]);
      expect(Number(month.rows[0].spent_usd)).toBeCloseTo(11.1);
      expect(Number(month.rows[0].safety_over_limit_usd)).toBeCloseTo(0.5);

      const calls = await db.query("select count(*)::int as n, sum(cost_usd)::float as usd from public.ai_calls where ref_id = $1", [ids.book]);
      expect(calls.rows[0].n).toBe(5);
      const notes = await db.query("select payload->>'state' as s from public.notifications where family_id = $1 and type = 'budget_state' order by created_at", [ids.family]);
      expect(notes.rows.map((r) => r.s)).toEqual(["warned", "budget", "hard_stop"]);

      // Raising the limit takes effect immediately.
      await db.query("update public.parent_settings set monthly_limit_usd = 100 where family_id = $1", [ids.family]);
      expect((await db.query("select state from public.get_budget_state($1)", [ids.family])).rows[0].state).toBe("normal");
    } finally {
      await db.query("rollback");
    }
  });

  it("is not callable by browser roles", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      expect(await errorCode(db, "select public.record_ai_call($1, '{}'::jsonb)", [ids.family])).toBe("42501");
      expect(await errorCode(db, "select public.get_budget_state($1)", [ids.family])).toBe("42501");
    });
  });
});

describe("jobs queue (ADR-015)", () => {
  it("dedupes pending jobs and claims each job once", async () => {
    await db.query("begin");
    try {
      await db.query("insert into public.jobs (family_id, type, dedupe_key) values ($1, 'ingest.extract', 'k1')", [ids.family]);
      expect(
        await errorCode(db, "insert into public.jobs (family_id, type, dedupe_key) values ($1, 'ingest.extract', 'k1')", [ids.family]),
      ).toBe("23505");
      const first = await db.query("select * from public.claim_jobs(5, 60)");
      expect(first.rows.map((r) => [r.type, r.status, r.attempts])).toEqual([["ingest.extract", "running", 1]]);
      expect((await db.query("select * from public.claim_jobs(5, 60)")).rows).toHaveLength(0);
      // An expired lock is reclaimed (crash recovery).
      await db.query("update public.jobs set locked_until = now() - interval '1 second' where dedupe_key = 'k1'");
      expect((await db.query("select * from public.claim_jobs(5, 60)")).rows[0].attempts).toBe(2);
      // Once done, the same key can be queued again.
      await db.query("update public.jobs set status = 'done' where dedupe_key = 'k1'");
      await db.query("insert into public.jobs (family_id, type, dedupe_key) values ($1, 'ingest.extract', 'k1')", [ids.family]);
    } finally {
      await db.query("rollback");
    }
  });
});

describe("hybrid search (US-2.3, US-2.6 KP-2, ADR-008)", () => {
  const search = async (text: string, tsq: string | null, embedding: string | null, extra: { kind?: string; subject?: string } = {}) =>
    (
      await db.query(
        "select * from public.search_chunks($1, $2, $3, $4::halfvec, $5, $6, null, 10)",
        [ids.family, text, tsq, embedding, extra.subject ?? null, extra.kind ?? null],
      )
    ).rows;

  it("returns fragments from the textbook and a book with name, type and page — best first", async () => {
    const rows = await search("дроби зі спільним знаменником", "дроб:* | спільн:* | знаменник:*", vec(1));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toMatchObject({ material_name: "Математика.pdf", material_kind: "textbook", page: 61 });
    expect(rows.map((r) => r.material_kind)).toContain("popular_science");
    expect(rows[0].snippet).toContain("знаменник");
  });

  it("never returns disabled books or other families' books", async () => {
    const rows = await search("дроби зі спільним знаменником", "дроб:*", vec(1));
    expect(rows.map((r) => r.material_name)).not.toContain("Вимкнена.pdf");
    expect(rows.map((r) => r.material_name)).not.toContain("Чужа.pdf");
  });

  it("works text-only when embeddings are unavailable", async () => {
    const rows = await search("відсоток", "відсот:*", null);
    expect(rows[0]).toMatchObject({ page: 12, vector_rank: null });
  });

  it("filters by type and subject", async () => {
    expect((await search("дроби", "дроб:*", vec(1), { kind: "popular_science" })).map((r) => r.material_kind)).toEqual(["popular_science"]);
    expect((await search("дроби", "дроб:*", vec(1), { subject: ids.math })).every((r) => r.material_name === "Математика.pdf")).toBe(true);
  });

  it("drops a book from results when it is switched off or removed (US-2.6 KP-2, KP-6)", async () => {
    await db.query("begin");
    try {
      await db.query("update public.materials set use_in_lessons = false where id = $1", [ids.book]);
      expect((await search("піца", "піц:*", vec(1))).map((r) => r.material_name)).not.toContain("Цікаві дроби.pdf");
      await db.query("update public.materials set use_in_lessons = true, status = 'removed' where id = $1", [ids.book]);
      expect((await search("піца", "піц:*", vec(1))).map((r) => r.material_name)).not.toContain("Цікаві дроби.pdf");
    } finally {
      await db.query("rollback");
    }
  });

  it("stores embeddings in batch and assigns fragments to the narrowest section/topic", async () => {
    await db.query("begin");
    try {
      const chunk = await db.query("select id from public.chunks where material_id = $1 and page = 12", [ids.textbook]);
      const n = await db.query("select public.set_chunk_embeddings($1, 'm', $2::jsonb)", [
        ids.family,
        JSON.stringify([{ id: chunk.rows[0].id, embedding: JSON.parse(vec(7)) }]),
      ]);
      expect(n.rows[0].set_chunk_embeddings).toBe(1);
      // Another family cannot write into our chunks through the function.
      const none = await db.query("select public.set_chunk_embeddings($1, 'm', $2::jsonb)", [
        ids.otherFamily,
        JSON.stringify([{ id: chunk.rows[0].id, embedding: JSON.parse(vec(9)) }]),
      ]);
      expect(none.rows[0].set_chunk_embeddings).toBe(0);

      const sec = await db.query(
        "insert into public.material_sections (owner_family_id, material_id, title, page_from, page_to) values ($1, $2, 'Розділ 1', 1, 80) returning id",
        [ids.family, ids.textbook],
      );
      const topic = await db.query(
        "insert into public.topics (owner_family_id, subject_id, material_id, section_id, title, page_from, page_to) values ($1, $2, $3, $4, 'Додавання дробів', 60, 62) returning id",
        [ids.family, ids.math, ids.textbook, sec.rows[0].id],
      );
      await db.query("select public.assign_chunk_structure($1, $2)", [ids.family, ids.textbook]);
      const rows = await db.query("select page, section_id, topic_id from public.chunks where material_id = $1 order by page", [ids.textbook]);
      expect(rows.rows).toEqual([
        { page: 12, section_id: sec.rows[0].id, topic_id: null },
        { page: 61, section_id: sec.rows[0].id, topic_id: topic.rows[0].id },
      ]);
      const hit = await search("спільного знаменника", "спільн:* | знаменник:*", vec(1));
      expect(hit[0]).toMatchObject({ topic_title: "Додавання дробів", section_title: "Розділ 1" });
    } finally {
      await db.query("rollback");
    }
  });

  it("is not callable by browser roles", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      expect(await errorCode(db, "select * from public.search_chunks($1, 'x', null)", [ids.family])).toBe("42501");
    });
  });
});

describe("RLS of S1 tables (NFR-PRIV-4, ADR-018)", () => {
  const TABLES = ["materials", "chunks", "ai_calls", "model_routes", "spend_months", "jobs", "integration_status", "material_sections", "topics"];

  beforeAll(async () => {
    await db.query("insert into public.ai_calls (family_id, role, provider, model) values ($1, 'embeddings', 'openai', 'x')", [ids.family]);
    await db.query("insert into public.jobs (family_id, type) values ($1, 'drive.sync')", [ids.family]);
    await db.query("insert into public.integration_status (family_id, kind, status) values ($1, 'drive_materials_public', '{}')", [ids.family]);
    await db.query("insert into public.spend_months (family_id, month, limit_usd) values ($1, '2000-01', 10)", [ids.family]);
    await db.query(
      "insert into public.topics (owner_family_id, subject_id, material_id, title) values ($1, $2, $3, 'Тема')",
      [ids.family, ids.math, ids.textbook],
    );
    await db.query("insert into public.material_sections (owner_family_id, material_id, title) values ($1, $2, 'Розділ')", [
      ids.family,
      ids.textbook,
    ]);
  });

  it("the parent reads the family's rows", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      for (const t of TABLES) {
        const { rows } = await db.query(`select * from public.${t}`);
        expect(rows.length, t).toBeGreaterThan(0);
      }
      const names = (await db.query("select name from public.materials")).rows.map((r) => r.name);
      expect(names).not.toContain("Чужа.pdf");
      expect((await db.query("select * from public.model_prices")).rows.length).toBeGreaterThan(0);
    });
  });

  it("the child, another family and anonymous users see nothing", async () => {
    for (const who of [
      { role: "authenticated" as const, sub: ids.childAuth },
      { role: "authenticated" as const, sub: ids.otherParentAuth },
    ]) {
      await asRole(db, who, async () => {
        for (const t of TABLES) {
          const { rows } = await db.query(`select * from public.${t} where ${t === "materials" || t === "chunks" || t === "topics" || t === "material_sections" ? "owner_family_id" : "family_id"} = $1`, [ids.family]);
          expect(rows, `${t} for ${who.sub}`).toHaveLength(0);
        }
      });
    }
    await asRole(db, { role: "anon" }, async () => {
      expect(await errorCode(db, "select * from public.materials")).toBe("42501");
      expect(await errorCode(db, "select * from public.model_prices")).toBe("42501");
    });
    await asRole(db, { role: "authenticated", sub: ids.childAuth }, async () => {
      expect((await db.query("select * from public.model_prices")).rows).toHaveLength(0);
    });
  });

  it("nobody writes from the browser", async () => {
    await asRole(db, { role: "authenticated", sub: ids.parentAuth }, async () => {
      expect(await errorCode(db, "update public.materials set use_in_lessons = false")).toBe("42501");
      expect(await errorCode(db, "insert into public.model_routes (family_id, role, primary_provider, primary_model) values ($1, 'x', 'a', 'b')", [ids.family])).toBe("42501");
      expect(await errorCode(db, "delete from public.chunks")).toBe("42501");
    });
  });
});
