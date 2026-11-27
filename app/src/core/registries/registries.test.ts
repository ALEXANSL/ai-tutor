import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "./registry";
import { childTiles, isInactivePlaceholder, parentNav, sortedNav } from "./navigation";
import { sessionModes, sourceTypes, stepTypes } from "./learning";
import { registerAll } from "@/modules";

registerAll();
registerAll(); // idempotent

describe("createRegistry", () => {
  it("rejects duplicate and empty keys", () => {
    const r = createRegistry<{ key: string }>("t");
    r.register({ key: "a" });
    expect(() => r.register({ key: "a" })).toThrow(/duplicate/);
    expect(() => r.register({ key: "" })).toThrow(/required/);
    expect(r.list()).toHaveLength(1);
  });
});

describe("parent navigation (US-11.8, US-2.7 KP-3)", () => {
  const items = sortedNav(parentNav.list());

  it("has six sections, in order (D-131)", () => {
    expect(items.map((i) => i.label)).toEqual(["Огляд", "Майстерня ШІ", "Предмети й курси", "Школа", "Бібліотека", "Дитина й налаштування"]);
    expect(items.find((i) => i.key === "books")).toMatchObject({ href: "/parent/catalog", status: "active" });
    expect(items.find((i) => i.key === "books")?.match).toEqual(expect.arrayContaining(["/parent/books", "/parent/library", "/parent/videos"]));
  });

  it("has no inactive placeholders in the menu (D-130)", () => {
    expect(items.some(isInactivePlaceholder)).toBe(false);
    expect(items.map((i) => i.key)).not.toContain("directives");
    expect(items.every((i) => i.href)).toBe(true);
  });

  it("puts the unread badge on the overview, which holds notifications", () => {
    expect(items.find((i) => i.badge)?.key).toBe("dashboard");
  });

  it("shows the child no inactive tiles (D-130)", () => {
    expect(childTiles.list().some(isInactivePlaceholder)).toBe(false);
  });
});

describe("school module registrations (ADR-017)", () => {
  it("registers the MVP mode, step types and source types", () => {
    expect(sessionModes.get("lesson")?.module).toBe("school");
    expect(stepTypes.get("interactive")?.interactive).toBe(true);
    expect(sourceTypes.list().map((s) => s.key)).toEqual([
      "textbook",
      "literary_work",
      "popular_science",
      "reference",
      "other",
      "test_fragment",
    ]);
    expect(sourceTypes.get("literary_work")?.structureStrategy).toBe("chapters");
  });
});

describe("module boundary (ADR-017: the core never imports modules)", () => {
  const coreDir = join(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(coreDir);

  it.each(files.map((f) => [f.slice(coreDir.length)]))("%s does not import from modules", (rel) => {
    const src = readFileSync(join(coreDir, rel), "utf8");
    if (rel.endsWith(".test.ts")) return;
    expect(src).not.toMatch(/from\s+["'](@\/modules|\.\.\/.*modules)/);
  });
});
