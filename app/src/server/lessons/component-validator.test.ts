import { describe, expect, it } from "vitest";
import "@/lesson-components"; // registers drag_sort
import { validateComponentRef } from "./component-validator";

/**
 * NFR-SAFE-15: an invalid or unsafe component description is replaced by a
 * plain choice/open exercise — never rendered, never blocks the lesson.
 */
const VALID_DRAG_SORT = {
  component: "drag_sort",
  v: 1,
  props: {
    variant: "pairs",
    instructionUk: "Спарувати дріб і десятковий запис",
    items: [
      { id: "a", labelUk: "1/2" },
      { id: "b", labelUk: "1/4" },
    ],
    slots: [
      { id: "s1", labelUk: "0,5" },
      { id: "s2", labelUk: "0,25" },
    ],
    answer: { a: "s1", b: "s2" },
  },
  fallback_text: "Скільки буде 1/2 у десятковому записі?",
};

describe("validateComponentRef (NFR-SAFE-15, ADR-020 §3)", () => {
  it("accepts a well-formed drag_sort description", () => {
    const res = validateComponentRef(VALID_DRAG_SORT);
    expect(res.ok).toBe(true);
  });

  it("rejects an unknown component key", () => {
    const res = validateComponentRef({ ...VALID_DRAG_SORT, component: "run_arbitrary_widget" });
    expect(res.ok).toBe(false);
  });

  it("rejects a <script> tag hidden in a card label", () => {
    const bad = { ...VALID_DRAG_SORT, props: { ...VALID_DRAG_SORT.props, items: [{ id: "a", labelUk: "<script>alert(1)</script>" }] } };
    const res = validateComponentRef(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fallback.type).toMatch(/choice|open/);
  });

  it("rejects an external link hidden in a label", () => {
    const bad = { ...VALID_DRAG_SORT, props: { ...VALID_DRAG_SORT.props, items: [{ id: "a", labelUk: "клікни https://evil.example/x" }] } };
    expect(validateComponentRef(bad).ok).toBe(false);
  });

  it("rejects raw HTML markup in a slot label", () => {
    const bad = { ...VALID_DRAG_SORT, props: { ...VALID_DRAG_SORT.props, slots: [{ id: "s1", labelUk: "<b>0,5</b>" }] } };
    expect(validateComponentRef(bad).ok).toBe(false);
  });

  it("rejects a semantically broken answer (missing item in the mapping)", () => {
    const bad = {
      ...VALID_DRAG_SORT,
      props: {
        ...VALID_DRAG_SORT.props,
        items: [
          { id: "a", labelUk: "1/2" },
          { id: "b", labelUk: "1/4" },
        ],
        answer: { a: "s1" }, // "b" never placed anywhere
      },
    };
    expect(validateComponentRef(bad).ok).toBe(false);
  });

  it("rejects a schema mismatch (too few items)", () => {
    const bad = { ...VALID_DRAG_SORT, props: { ...VALID_DRAG_SORT.props, items: [{ id: "a", labelUk: "only one" }] } };
    expect(validateComponentRef(bad).ok).toBe(false);
  });

  it("falls back to a safe default when even fallback_text is missing", () => {
    const res = validateComponentRef({ component: "unknown_thing" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fallback.content.questionUk).toBeTruthy();
  });
});
