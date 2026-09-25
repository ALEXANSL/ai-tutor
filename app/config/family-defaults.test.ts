import { describe, expect, it } from "vitest";
import familyDefaults from "./family-defaults.json";

/** BUG-001 regression guard: US-1.7 KP-2 (PM-21) — 3 female and 3 male suggestions. */
describe("family-defaults tutorNameOptions", () => {
  const { f, m } = familyDefaults.tutorNameOptions;

  it("offers at least 3 female and 3 male tutor names", () => {
    expect(f.length).toBeGreaterThanOrEqual(3);
    expect(m.length).toBeGreaterThanOrEqual(3);
  });

  it("gives every suggestion a name and a short hint in the same format", () => {
    for (const option of [...f, ...m]) {
      expect(option.name).toMatch(/^[\p{L}’' -]{2,20}$/u);
      expect(option.hint).toMatch(/^\p{Ll}[\p{L} ]+ [йі] [\p{L} ]+$/u);
    }
  });

  it("never lists the same name in both groups (the group decides the gender)", () => {
    const female = new Set(f.map((o) => o.name));
    expect(m.filter((o) => female.has(o.name))).toEqual([]);
  });
});
