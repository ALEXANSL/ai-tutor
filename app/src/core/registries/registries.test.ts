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

  it("has 'Мої книги' as a separate active menu item", () => {
    const books = items.find((i) => i.key === "books");
    expect(books).toMatchObject({ label: "Мої книги", href: "/parent/books", status: "active" });
  });

  it("ends with an inactive 'Модулі (скоро)' item without link", () => {
    const last = items.at(-1)!;
    expect(last.label).toBe("Модулі (скоро)");
    expect(isInactivePlaceholder(last)).toBe(true);
    expect(Object.keys(last).sort()).toEqual(["href", "icon", "key", "label", "order", "status"]);
  });

  it("puts the unread badge on notifications", () => {
    expect(items.find((i) => i.badge)?.key).toBe("notifications");
  });

  it("offers an inactive modules tile to the child as well (US-11.8 KP-3)", () => {
    expect(childTiles.list().every(isInactivePlaceholder)).toBe(true);
  });
});

describe("school module registrations (ADR-017)", () => {
  it("registers the MVP mode, step types and source types", () => {
    expect(sessionModes.get("lesson")?.module).toBe("school");
    expect(stepTypes.get("interactive")?.interactive).toBe(true);
    expect(sourceTypes.list().map((s) => s.key)).toEqual(["textbook", "literary_work", "test_fragment"]);
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
