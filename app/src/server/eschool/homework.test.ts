import { beforeEach, expect, it, vi } from "vitest";
import { schoolPacketFixture } from "./__fixtures__/packet";
import type { SchoolEntry } from "@/lib/eschool";
const f = vi.hoisted(() => ({ replacement: vi.fn(), read: vi.fn(), update: vi.fn(), view: vi.fn() }));
vi.mock("@/server/studio/links", () => ({ studioReplacementForPath: f.replacement }));
vi.mock("./store", () => ({ readSchoolDoc: f.read, SCHOOL_ENTRY: "eschool.entry" }));
vi.mock("./service", () => ({ updateSchoolEntry: f.update }));
vi.mock("@/server/lessons/literatureV3View", () => ({ getLiteratureV3LessonView: f.view }));
import { schoolAssignment, schoolAssignmentPrompt, schoolHomeworkLaunch, attachSchoolWork } from "./homework";
const lessonId = "11111111-1111-4111-8111-111111111111";
let entry: SchoolEntry;
beforeEach(() => { vi.clearAllMocks(); f.replacement.mockResolvedValue(null); const packet = schoolPacketFixture(); entry = { version: 1, revision: 0, childId: "child", identity: packet.identity, source: packet.entries[1]!, capturedAt: packet.capturedAt, syncedAt: packet.capturedAt, status: "todo", changed: false, subjectId: "subject", topicId: "topic", lessonHref: `/literature-v3/${lessonId}`, workHref: null }; f.read.mockImplementation(async () => entry); f.view.mockResolvedValue({ subjectId: "subject", flow: [{ id: "real-step" }] }); });
it("uses a real lesson target and carries the teacher's exact assignment into the homework composer", async () => {
  const href = await schoolHomeworkLaunch("family", "child", "assignment");
  const url = new URL(href!, "https://app.test"); expect(JSON.parse(url.searchParams.get("target")!)).toEqual({ kind: "chapter", lessonId, stepId: "real-step" }); expect(url.searchParams.get("assignment")).toBe("assignment");
  expect(schoolAssignmentPrompt(entry)).toContain("Підготуй презентацію на 7 слайдів"); expect(f.read).toHaveBeenCalledWith("family", "child", "assignment", "eschool.entry");
});
it("refuses missing or cross-subject tasks instead of reading or attaching them", async () => {
  await expect(schoolAssignment("family", "child", "assignment", "other-subject")).rejects.toThrow(); f.read.mockResolvedValue(null);
  await expect(schoolAssignment("other-family", "other-child", "assignment")).rejects.toThrow(); expect(f.update).not.toHaveBeenCalled();
});
it("links a work without marking it done or overwriting a child's completed status", async () => {
  const target = { kind: "chapter" as const, lessonId, stepId: "real-step" };
  await attachSchoolWork("family", "child", "assignment", "work", target); expect(f.update.mock.calls[0]![4]).toMatchObject({ status: "working" });
  entry.status = "done"; await attachSchoolWork("family", "child", "assignment", "work", target); expect(f.update.mock.calls[1]![4]).not.toHaveProperty("status");
});

it("opens the published replacement for a linked diary assignment", async () => {
  const replacement = "44444444-4444-4444-8444-444444444444"; f.replacement.mockResolvedValue(`/literature-v3/${replacement}`);
  await schoolHomeworkLaunch("family", "child", "assignment"); expect(f.view).toHaveBeenCalledWith("family", replacement, { includeIllustrations: false });
});
