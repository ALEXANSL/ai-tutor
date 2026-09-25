import { describe, expect, it } from "vitest";
import { evaluateDragSort, validateDragSortSemantics, type DragSortProps } from "./index";

const pairsProps: DragSortProps = {
  variant: "pairs",
  instructionUk: "Спаруй дріб і десятковий запис",
  items: [
    { id: "a", labelUk: "1/2" },
    { id: "b", labelUk: "1/4" },
  ],
  slots: [
    { id: "s1", labelUk: "0,5" },
    { id: "s2", labelUk: "0,25" },
  ],
  answer: { a: "s1", b: "s2" },
};

describe("evaluateDragSort (US-6.8 КП-2а, US-16.2 КП-1 — device-side, no AI)", () => {
  it("is fully correct when every item is on its target slot", () => {
    const res = evaluateDragSort(pairsProps, { a: "s1", b: "s2" });
    expect(res.correct).toBe(true);
    expect(res.detail).toEqual({ a: true, b: true });
  });

  it("reports per-item detail when only some are right (partial visual feedback)", () => {
    const res = evaluateDragSort(pairsProps, { a: "s1", b: "s1" });
    expect(res.correct).toBe(false);
    expect(res.detail).toEqual({ a: true, b: false });
  });

  it("treats an unplaced item as wrong, not a crash", () => {
    const res = evaluateDragSort(pairsProps, { a: "s1" });
    expect(res.correct).toBe(false);
    expect(res.detail.b).toBe(false);
  });

  it("groups variant allows several items on the same slot", () => {
    const groups: DragSortProps = {
      variant: "groups",
      instructionUk: "Розклади по групах",
      items: [
        { id: "a", labelUk: "кіт" },
        { id: "b", labelUk: "пес" },
        { id: "c", labelUk: "дуб" },
      ],
      slots: [
        { id: "animals", labelUk: "Тварини" },
        { id: "plants", labelUk: "Рослини" },
      ],
      answer: { a: "animals", b: "animals", c: "plants" },
    };
    expect(validateDragSortSemantics(groups)).toBeNull();
    expect(evaluateDragSort(groups, { a: "animals", b: "animals", c: "plants" }).correct).toBe(true);
  });

  it("timeline variant orders events (a drag_sort variant, ADR-020 §6 — no separate component)", () => {
    const timeline: DragSortProps = {
      variant: "timeline",
      instructionUk: "Розстав події в хронологічному порядку",
      items: [
        { id: "e1", labelUk: "Подія 1" },
        { id: "e2", labelUk: "Подія 2" },
        { id: "e3", labelUk: "Подія 3" },
      ],
      slots: [
        { id: "p1", labelUk: "1" },
        { id: "p2", labelUk: "2" },
        { id: "p3", labelUk: "3" },
      ],
      answer: { e1: "p1", e2: "p2", e3: "p3" },
    };
    expect(validateDragSortSemantics(timeline)).toBeNull();
    expect(evaluateDragSort(timeline, { e1: "p2", e2: "p1", e3: "p3" }).correct).toBe(false);
  });
});

describe("validateDragSortSemantics (ADR-020 §3b)", () => {
  it("rejects duplicate slot ids", () => {
    const bad: DragSortProps = { ...pairsProps, slots: [{ id: "s1", labelUk: "a" }, { id: "s1", labelUk: "b" }] };
    expect(validateDragSortSemantics(bad)).not.toBeNull();
  });

  it("rejects an answer that references an unknown slot", () => {
    const bad: DragSortProps = { ...pairsProps, answer: { a: "ghost", b: "s2" } };
    expect(validateDragSortSemantics(bad)).not.toBeNull();
  });

  it("rejects pairs/order/timeline variants sharing a slot between two items", () => {
    const bad: DragSortProps = { ...pairsProps, answer: { a: "s1", b: "s1" } };
    expect(validateDragSortSemantics(bad)).not.toBeNull();
  });

  it("accepts a well-formed pairs description", () => {
    expect(validateDragSortSemantics(pairsProps)).toBeNull();
  });
});
