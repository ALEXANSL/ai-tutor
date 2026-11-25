import { describe, expect, it } from "vitest";
import { homeworkSummary } from "./homework-summary";
import type { SchoolEntryView } from "./eschool";

const row = (id: string, dueDate: string | null, extra: Partial<{ status: string; kind: string; cancelled: boolean; workHref: string | null }> = {}) => ({
  id,
  entry: {
    status: extra.status ?? "todo", workHref: extra.workHref ?? null, lessonHref: null,
    source: { kind: extra.kind ?? "homework", dueDate, subject: "Математика", text: `Задача ${id}`, topic: "", cancelled: extra.cancelled ?? false },
  },
}) as unknown as SchoolEntryView;

describe("homeworkSummary (D-132)", () => {
  const today = "2026-11-25";
  it("counts overdue, today and upcoming homework and lists the most urgent first", () => {
    const s = homeworkSummary([row("a", "2026-11-28"), row("b", "2026-11-25"), row("c", "2026-11-20", { workHref: "/homework?work=1" }), row("d", null)], today);
    expect(s).toMatchObject({ overdue: 1, today: 1, soon: 2 });
    expect(s.open.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(s.open[0]!.href).toBe("/homework?work=1");
    expect(s.open[1]!.href).toBe("/school");
  });
  it("ignores done, cancelled and non-homework entries", () => {
    const s = homeworkSummary([row("a", today, { status: "done" }), row("b", today, { cancelled: true }), row("c", today, { kind: "lesson" })], today);
    expect(s).toEqual({ overdue: 0, today: 0, soon: 0, open: [] });
  });
});
