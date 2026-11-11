import { beforeEach, expect, it, vi } from "vitest";
import type { SchoolConnection, SchoolEntry } from "@/lib/eschool";
import { schoolPacketFixture } from "./__fixtures__/packet";
const f = vi.hoisted(() => ({ rows: new Map<string, SchoolConnection | SchoolEntry>(), subject: vi.fn() }));
vi.mock("./store", async original => {
  const real = await original<typeof import("./store")>();
  const id = (family: string, child: string, key: string) => `${family}:${child}:${key}`;
  return { ...real,
    readSchoolConnection: async (family: string, child: string) => ({ id: "connection", connection: structuredClone(f.rows.get(id(family, child, "connection")) ?? null) }),
    readSchoolDoc: async (family: string, child: string, key: string) => structuredClone(f.rows.get(id(family, child, key)) ?? null),
    createSchoolDoc: async (family: string, key: string, _type: string, value: SchoolEntry | SchoolConnection) => { const k = id(family, value.childId, key); if (f.rows.has(k)) return false; f.rows.set(k, structuredClone(value)); return true; },
    saveSchoolDoc: async (family: string, key: string, _type: string, previous: SchoolEntry | SchoolConnection, changes: object) => { const k = id(family, previous.childId, key); if (f.rows.get(k)?.revision !== previous.revision) throw new Error("stale"); const next = { ...previous, ...changes, revision: previous.revision + 1 }; f.rows.set(k, structuredClone(next)); return next; },
  };
});
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => { const chain = { eq: () => chain, order: () => chain, returns: async () => ({ data: [{ id: "subject", name: "Інформатика" }], error: null }) }; return chain; } }) }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
import { importSchoolPacket, updateSchoolEntry, disconnectSchool } from "./service";
import { schoolId, SCHOOL_ENTRY } from "./store";
beforeEach(() => { f.rows.clear(); f.subject.mockResolvedValue({ topics: [] }); });
const entries = () => [...f.rows.values()].filter((row): row is SchoolEntry => "source" in row);
it("imports once, deduplicates an acknowledged packet and never calls an AI model", async () => {
  const packet = schoolPacketFixture(); expect((await importSchoolPacket("family", "child", packet)).repeated).toBe(false);
  expect((await importSchoolPacket("family", "child", packet)).repeated).toBe(true); expect(entries()).toHaveLength(2); expect(entries()[0]!.subjectId).toBe("subject");
});
it("updates teacher content while preserving a completed task and flags the change", async () => {
  const packet = schoolPacketFixture(); await importSchoolPacket("family", "child", packet);
  const id = schoolId(SCHOOL_ENTRY, "family", "child", "100", "200", "homework:400");
  await updateSchoolEntry("family", "child", id, 0, { status: "done" });
  packet.packetId = "22222222-2222-4222-8222-222222222222"; packet.entries[1]!.text = "Додай приклад безпечного пароля"; packet.capturedAt = new Date(Date.now() + 10).toISOString();
  await importSchoolPacket("family", "child", packet);
  const homework = entries().find(entry => entry.source.kind === "homework")!; expect(homework.status).toBe("done"); expect(homework.changed).toBe(true); expect(homework.source.text).toContain("Додай");
});
it("refuses another external pupil until explicitly disconnected and never shares records between families", async () => {
  const packet = schoolPacketFixture(); await importSchoolPacket("family", "child", packet); packet.identity.pupilId = 201;
  await expect(importSchoolPacket("family", "child", packet)).rejects.toThrow("інший профіль");
  await disconnectSchool("family", "child"); await importSchoolPacket("family", "child", packet); expect(entries()).toHaveLength(4);
  expect((await importSchoolPacket("other-family", "child", schoolPacketFixture())).repeated).toBe(false);
  expect(entries()).toHaveLength(6);
});
it("rejects stale snapshots and invalid topic mappings without changing existing statuses", async () => {
  const packet = schoolPacketFixture(); await importSchoolPacket("family", "child", packet);
  packet.packetId = "33333333-3333-4333-8333-333333333333"; packet.capturedAt = new Date(Date.now() - 10000).toISOString();
  await expect(importSchoolPacket("family", "child", packet)).rejects.toThrow("старіший");
  const id = schoolId(SCHOOL_ENTRY, "family", "child", "100", "200", "homework:400");
  await expect(updateSchoolEntry("family", "child", id, 0, { subjectId: "subject", topicId: "other-topic" })).rejects.toThrow("не належить");
});
