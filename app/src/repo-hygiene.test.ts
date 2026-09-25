/**
 * Repository hygiene checks for this slice's DoD:
 *  - no real e-mails / secrets in code, config, migrations (US-1.1 KP-3, NFR-PRIV-8, DoD p.3);
 *  - no hard-coded school year / grade / time zone in application code (NFR-PLAT-7, DoD p.10).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(__dirname, "..");
const REPO = join(APP, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "public"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json|sql|toml|sh|example)$/.test(name) && name !== "package-lock.json") out.push(p);
  }
  return out;
}

const files = [...walk(APP), ...walk(join(REPO, "supabase"))];

describe("no personal data or secrets in the repository", () => {
  it("contains only placeholder e-mail addresses", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const emails = readFileSync(f, "utf8").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      for (const e of emails) {
        if (!/@(example\.com|resend\.dev)$/i.test(e)) {
          offenders.push(`${relative(REPO, f)}: ${e}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no values in .env.example", () => {
    const lines = readFileSync(join(APP, ".env.example"), "utf8").split("\n");
    const assigned = lines.filter((l) => /^[A-Z0-9_]+=\S/.test(l));
    expect(assigned).toEqual([]);
  });

  it("does not contain API-key-looking strings", () => {
    const pattern = /(sk-ant-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|eyJhbGciOi[A-Za-z0-9._-]{40,}|\d{8,10}:AA[A-Za-z0-9_-]{30,})/;
    const offenders = files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

describe("school year, grade and time zone are data, not code (NFR-PLAT-7)", () => {
  const code = files.filter(
    (f) => f.startsWith(join(APP, "src")) && !f.endsWith(".test.ts") && /\.(ts|tsx)$/.test(f),
  );
  it.each(code.map((f) => [relative(APP, f)]))("%s", (rel) => {
    const src = readFileSync(join(APP, rel), "utf8");
    expect(src).not.toMatch(/\b20\d\d\/\d\d\b/); // e.g. "2026/27"
    expect(src).not.toMatch(/\d+\s*клас/i); // e.g. "6 клас"
    expect(src).not.toMatch(/Europe\/Kyiv/);
  });
});
