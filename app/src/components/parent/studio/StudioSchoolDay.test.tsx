import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { StudioSchoolDay } from "./StudioSchoolDay";
import type { SchoolDay } from "@/lib/school-day";
import type { SchoolEntryView } from "@/lib/eschool";

const entry = (id: string, kind: "lesson" | "homework", extra: Partial<SchoolEntryView["entry"]> = {}): SchoolEntryView => ({ id, entry: {
  version: 1, revision: 0, childId: "c", identity: { schoolId: 1, pupilId: 1, classLabel: "6" }, capturedAt: "", syncedAt: "", status: "todo", changed: false,
  subjectId: null, topicId: null, lessonHref: null, workHref: null, ...extra,
  source: { externalId: `${kind}:1`, kind, appointmentId: 1, subjectExternalId: 1, subject: "Математика", lessonDate: "2026-11-26", dueDate: kind === "homework" ? "2026-11-26" : null, topic: "Дроби", text: kind === "homework" ? "№ 245" : "", attachments: 0, cancelled: false, schedule: { number: 1, start: "08:00", room: null } },
} });

it("links each lesson and homework to a prefilled Studio form and shows what exists", () => {
  const day: SchoolDay = { date: "2026-11-26", previous: "2026-11-24", next: null, overdue: [], unscheduled: [],
    lessons: [{ lesson: entry("l1", "lesson"), homework: [entry("h1", "homework")] }, { lesson: entry("l2", "lesson", { lessonHref: "/literature-v3/x", topicId: "t" }), homework: [] }] };
  const html = renderToStaticMarkup(<StudioSchoolDay day={day} deckTopics={new Set(["t"])} connected today="2026-11-25" />);
  expect(html).toContain('href="/parent/studio/new?school=l1"');
  expect(html).toContain('href="/parent/studio/new?school=h1"');
  expect(html).toContain("Немає матеріалів"); expect(html).toContain("Є урок"); expect(html).toContain("Є презентація");
  expect(html).toContain('href="/parent/studio?tab=school&amp;date=2026-11-24"');
  expect(html).not.toContain("Додати презентацію");
});

it("asks for a diary import when nothing is connected", () => {
  const html = renderToStaticMarkup(<StudioSchoolDay day={{ date: null, previous: null, next: null, lessons: [], unscheduled: [], overdue: [] }} deckTopics={new Set()} connected={false} />);
  expect(html).toContain("Розклад ще не імпортовано");
});

it("offers batch checkboxes for lessons without materials and for homework, plus a whole-day button", () => {
  const day: SchoolDay = { date: "2026-11-26", previous: null, next: null, overdue: [], unscheduled: [],
    lessons: [{ lesson: entry("l1", "lesson"), homework: [entry("h1", "homework")] }, { lesson: entry("l2", "lesson", { lessonHref: "/x" }), homework: [] }] };
  const html = renderToStaticMarkup(<StudioSchoolDay day={day} deckTopics={new Set()} connected today="2026-11-25" />);
  expect(html.match(/До пакета: урок/g)).toHaveLength(1);
  expect(html).toContain("До пакета: допомога з ДЗ"); expect(html).toContain("Додати весь день до пакета");
});
