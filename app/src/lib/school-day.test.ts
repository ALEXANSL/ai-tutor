import { expect, it } from "vitest";
import { schoolDay, schoolStudioPrefill } from "./school-day";
import type { SchoolEntryView, SchoolSource } from "./eschool";

let n = 0;
function view(source: Partial<SchoolSource>, status: SchoolEntryView["entry"]["status"] = "todo"): SchoolEntryView {
  n += 1;
  const full: SchoolSource = { externalId: `lesson:${n}`, kind: "lesson", appointmentId: n, subjectExternalId: 1, subject: "Математика", lessonDate: "2026-11-26", dueDate: null, topic: "", text: "", attachments: 0, cancelled: false, ...source };
  return { id: `id-${n}`, entry: { version: 1, revision: 0, childId: "c", identity: { schoolId: 1, pupilId: 1, classLabel: "6-А" }, source: full, capturedAt: "", syncedAt: "", status, changed: false, subjectId: null, topicId: null, lessonHref: null, workHref: null } };
}

const entries = [
  view({ lessonDate: "2026-11-24", subject: "Історія", subjectExternalId: 3 }),
  view({ lessonDate: "2026-11-26", subject: "Українська мова", subjectExternalId: 2, schedule: { number: 2, start: "09:00", room: null } }),
  view({ lessonDate: "2026-11-26", schedule: { number: 1, start: "08:00", room: "12" }, topic: "Дроби" }),
  view({ lessonDate: "2026-11-26", cancelled: true, subject: "Музика", subjectExternalId: 9 }),
  view({ kind: "homework", lessonDate: "2026-11-24", dueDate: "2026-11-26", text: "№ 245" }),
  view({ kind: "homework", lessonDate: "2026-11-24", dueDate: "2026-11-26", subject: "Англійська", subjectExternalId: 5, text: "Ex. 3" }),
  view({ kind: "homework", lessonDate: "2026-11-20", dueDate: "2026-11-23", subject: "Історія", subjectExternalId: 3 }),
  view({ kind: "homework", lessonDate: "2026-11-20", dueDate: "2026-11-22", subject: "Історія", subjectExternalId: 3 }, "done"),
  view({ lessonDate: "2026-11-30", subject: "Історія", subjectExternalId: 3 }),
];

it("defaults to the next lesson day, orders lessons and attaches that day's homework", () => {
  const day = schoolDay(entries, null, "2026-11-25");
  expect(day.date).toBe("2026-11-26");
  expect(day.previous).toBe("2026-11-24"); expect(day.next).toBe("2026-11-30");
  expect(day.lessons.map(item => item.lesson.entry.source.subject)).toEqual(["Математика", "Українська мова"]);
  expect(day.lessons[0]!.homework.map(item => item.entry.source.text)).toEqual(["№ 245"]);
  expect(day.unscheduled.map(item => item.entry.source.text)).toEqual(["Ex. 3"]);
  expect(day.overdue).toHaveLength(1);
});

it("navigates to any requested day and falls back to the latest day when nothing is ahead", () => {
  expect(schoolDay(entries, "2026-11-24", "2026-11-25").lessons.map(item => item.lesson.entry.source.subject)).toEqual(["Історія"]);
  const late = schoolDay(entries, null, "2026-12-10");
  expect(late.date).toBe("2026-11-30"); expect(late.next).toBeNull();
  expect(schoolDay([], null, "2026-11-25").date).toBeNull();
});

it("prefills homework help that explains without handing over answers", () => {
  const homework = schoolStudioPrefill(entries[4]!.entry.source);
  expect(homework.title).toBe("ДЗ: Математика");
  expect(homework.idea).toContain("№ 245");
  expect(homework.idea).toContain("Готових відповідей до самого завдання не давай");
  expect(schoolStudioPrefill(entries[2]!.entry.source)).toEqual(expect.objectContaining({ title: "Дроби" }));
});
