import { expect, it } from "vitest";
import { schoolDateShift, schoolWeekStart, schoolOccurrences } from "./school-schedule";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
import type { SchoolEntryView } from "./eschool";
it("keeps calendar weeks correct across month/year and timezone boundaries", () => {
  expect(schoolWeekStart("2026-11-13")).toBe("2026-11-09"); expect(schoolWeekStart("2027-01-01")).toBe("2026-12-28"); expect(schoolDateShift("2026-12-28", 7)).toBe("2027-01-04");
});
it("merges lessons/homework by appointment and retains all task states without inventing times", () => {
  const packet = schoolPacketFixture(); const records = packet.entries.map((source, index) => ({ id: String(index), entry: { source, status: "todo", changed: false } })) as SchoolEntryView[];
  const grouped = schoolOccurrences(records); expect(grouped).toHaveLength(1); expect(grouped[0]!.lesson?.id).toBe("0"); expect(grouped[0]!.homework[0]!.id).toBe("1"); expect(grouped[0]!.date).toBe("2026-11-11"); expect(grouped[0]!.lesson!.entry.source.schedule).toBeUndefined();
});
