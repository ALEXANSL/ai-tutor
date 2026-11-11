import { expect, it } from "vitest";
import { schoolPacketSchema, schoolDue, schoolToday } from "./eschool";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
it("accepts normalized homework and rejects credentials, duplicate IDs and invalid calendar dates", () => {
  const packet = schoolPacketFixture(); expect(schoolPacketSchema.safeParse(packet).success).toBe(true);
  expect(schoolPacketSchema.safeParse({ ...packet, cookies: "never-transfer" }).success).toBe(false);
  expect(schoolPacketSchema.safeParse({ ...packet, entries: [...packet.entries, packet.entries[0]] }).success).toBe(false);
  expect(schoolPacketSchema.safeParse({ ...packet, range: { start: "2026-02-30", end: "2026-03-03" } }).success).toBe(false);
});
it("uses the actual due date, never a guessed lesson deadline, in the Kyiv timezone", () => {
  const source = schoolPacketFixture().entries[1]!;
  expect(schoolDue(source, "todo", "2026-11-13")).toBe("На сьогодні"); expect(schoolDue(source, "done", "2026-11-14")).toBeNull();
  expect(schoolDue({ ...source, dueDate: null }, "todo", "2026-11-14")).toBe("Термін не вказано");
  expect(schoolToday(new Date("2026-11-11T23:30:00Z"))).toBe("2026-11-12");
});
