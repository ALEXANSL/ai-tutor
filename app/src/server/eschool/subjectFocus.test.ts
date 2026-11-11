import { beforeEach, expect, it, vi } from "vitest";
import type { SchoolEntry } from "@/lib/eschool";
import { schoolPacketFixture } from "./__fixtures__/packet";
const read = vi.hoisted(() => vi.fn());
vi.mock("./store", () => ({ readSchoolDoc: read, SCHOOL_ENTRY: "eschool.entry" }));
import { schoolSubjectFocus } from "./subjectFocus";
const id = "11111111-1111-4111-8111-111111111111";
const packet = schoolPacketFixture();
const entry: SchoolEntry = { version: 1, revision: 0, childId: "child", identity: packet.identity, source: packet.entries[1]!, capturedAt: packet.capturedAt, syncedAt: packet.capturedAt, status: "todo", changed: false, subjectId: "subject", topicId: "topic", lessonHref: null, workHref: null };
beforeEach(() => { vi.clearAllMocks(); read.mockResolvedValue(entry); });
it("resolves only a record owned by the current family/child and matching subject", async () => {
  expect(await schoolSubjectFocus("family", "child", "subject", id, [{ id: "topic", title: "Безпека" }])).toMatchObject({ topicId: "topic", entryId: id });
  expect(read).toHaveBeenCalledWith("family", "child", id, "eschool.entry");
  expect(await schoolSubjectFocus("family", "child", "other", id, [])).toBeNull();
  read.mockResolvedValue(null); expect(await schoolSubjectFocus("other-family", "other-child", "subject", id, [])).toBeNull();
});
it("ignores invalid query identifiers without a database read", async () => {
  expect(await schoolSubjectFocus("family", "child", "subject", "not-an-id", [])).toBeNull(); expect(read).not.toHaveBeenCalled();
});
