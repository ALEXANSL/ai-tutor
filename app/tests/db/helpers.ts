import pg from "pg";
import familyDefaults from "@config/family-defaults.json";

export const defaults = familyDefaults;

export function connect(): pg.Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — run via `npm run test:db`");
  return new pg.Client({ connectionString: url });
}

/** Runs `fn` as an API caller (anon / authenticated JWT sub) inside a rolled-back transaction. */
export async function asRole<T>(
  db: pg.Client,
  who: { role: "anon" } | { role: "authenticated"; sub: string },
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${who.role}`);
    const claims = who.role === "authenticated" ? { sub: who.sub, role: "authenticated" } : { role: "anon" };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

export async function createAuthUser(db: pg.Client, email: string, meta: object = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify(meta)],
  );
  return rows[0]!.id;
}

/** Postgres error code of a failing statement, run inside a savepoint. */
export async function errorCode(db: pg.Client, sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query("savepoint probe");
  try {
    await db.query(sql, params);
    await db.query("release savepoint probe");
    return null;
  } catch (e) {
    await db.query("rollback to savepoint probe");
    return (e as { code?: string }).code ?? "unknown";
  }
}
