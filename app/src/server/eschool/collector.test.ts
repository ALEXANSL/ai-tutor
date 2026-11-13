// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectEsSchool } from "../../../companion/eschool/collector.mjs";
import { schoolPacketSchema } from "@/lib/eschool";
const calls: { url: URL; method: string }[] = [];
let role = "schoolboy", denied = false;
beforeEach(() => {
  calls.length = 0; role = "schoolboy"; denied = false;
  vi.stubGlobal("location", { origin: "https://diary.eschool-ua.com" });
  vi.stubGlobal("fetch", vi.fn(async (input: URL, options: RequestInit) => {
    const url = new URL(input); calls.push({ url, method: options.method! });
    if (denied) return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    const data = url.pathname === "/api/profile" ? { Id: 200, SchoolId: 100, ClassId: 99, FirstName: "PRIVATE_NAME" }
      : url.pathname === "/api/v1/seplogin" ? { Items: [{ user_id: 200, school_id: 100, role }, { user_id: 999, school_id: 100, role: "schoolboy" }] }
      : url.pathname.endsWith("/Appointment") ? { Quantity: 1, Items: [{ Id: 300, SubjectId: 10, Subject: "Інформатика", LessonNumber: 4, StartTime: "10:55:00", RoomNumber: "227", Date: "2026-11-11T00:00:00", Embed: { Topics: [{ Id: 500, Title: "Безпека в мережі" }], TargetHomeworks: [{ Id: 400 }], Teacher: { Email: "PRIVATE_EMAIL" }, Rates: [{ Rate: "PRIVATE_GRADE" }] } }] }
      : { Id: 400, Topic: "Безпека", Description: "<p>Підготуй презентацію<br>7 слайдів &amp; приклади</p>", AppointmentDate: "2026-11-11", TargetAppointmentDate: "2026-11-13", HaveAnswer: true, Embed: { Files: [{ Url: "PRIVATE_URL", Name: "PRIVATE_FILE" }] } };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());
it("reads only the active pupil through GET requests and exports homework without credentials, names, grades or file URLs", async () => {
  const packet = schoolPacketSchema.parse(await collectEsSchool("2026-11-09", "2026-11-15"));
  expect(packet.entries).toHaveLength(2); expect(packet.entries[0]!.schedule).toEqual({ number: 4, start: "10:55", room: "227" }); expect(packet.entries[1]!.schedule).toEqual(packet.entries[0]!.schedule); expect(packet.entries[1]!.text).toContain("7 слайдів & приклади"); expect(packet.entries[1]!.dueDate).toBe("2026-11-13");
  expect(JSON.stringify(packet)).not.toContain("PRIVATE_"); expect(calls.every(call => call.method === "GET")).toBe(true);
  expect(calls.find(call => call.url.pathname.endsWith("Appointment"))!.url.pathname).toContain("/SchoolBoy/200/"); expect(calls.some(call => call.url.pathname.includes("999"))).toBe(false);
});
it("stops on an expired session or a non-pupil profile instead of guessing another child's ID", async () => {
  denied = true; expect(await collectEsSchool("2026-11-09", "2026-11-15")).toMatchObject({ error: expect.stringContaining("ESCHOOL-LOGIN") });
  denied = false; role = "teacher"; calls.length = 0;
  expect(await collectEsSchool("2026-11-09", "2026-11-15")).toMatchObject({ error: expect.stringContaining("ESCHOOL-PUPIL") }); expect(calls.some(call => call.url.pathname.endsWith("Appointment"))).toBe(false);
});
it("requests the same detail embed as the diary and preserves schedule fields omitted by a detail response", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/Appointment")) return Response.json({ Items: [{ Id: 300, Subject: "Математика", Date: "2026-11-11", Embed: { TargetHomeworks: [{ Id: 400, Description: "Повний текст із розкладу", TargetAppointmentDate: "2026-11-13", FilesCount: 2 }] } }] });
    if (url.pathname.endsWith("/Homework/400")) {
      expect(url.searchParams.get("embed")).toBe("File");
      return Response.json({ Id: 400, Description: null, Topic: "Повторення" });
    }
    return original(input, options);
  });
  const packet = schoolPacketSchema.parse(await collectEsSchool("2026-11-09", "2026-11-15"));
  expect(packet.complete).toBe(true);
  expect(packet.entries[1]).toMatchObject({ text: "Повний текст із розкладу", dueDate: "2026-11-13", attachments: 2 });
});
it.each([
  [429, "ESCHOOL-HTTP-429"], [503, "ESCHOOL-HTTP-503"], ["timeout", "ESCHOOL-TIMEOUT"], ["network", "ESCHOOL-NETWORK"], ["shape", "ESCHOOL-HOMEWORK-SHAPE"], ["bodyTimeout", "ESCHOOL-TIMEOUT"], ["json", "ESCHOOL-JSON"],
])("retains imported conditions and exposes a safe diagnostic code for %s", async (failure, code) => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/Appointment")) return Response.json({ Items: [{ Id: 300, Subject: "Математика", Date: "2026-11-11", Embed: { TargetHomeworks: [{ Id: 400, Description: "Розв’яжи вправу", FilesCount: 1 }] } }] });
    if (url.pathname.endsWith("/Homework/400")) {
      if (failure === "timeout") throw new DOMException("PRIVATE_TOKEN", "TimeoutError");
      if (failure === "network") throw Error("PRIVATE_TOKEN");
      if (failure === "bodyTimeout") { const response = Response.json({}); response.text = async () => { throw new DOMException("PRIVATE_TOKEN", "AbortError"); }; return response; }
      if (failure === "json") return new Response("PRIVATE_NOT_JSON", { headers: { "content-type": "application/json" } });
      if (failure === "shape") return Response.json({ Id: 999, Description: "PRIVATE_OTHER_PUPIL" });
      return new Response("PRIVATE_SERVER_BODY", { status: failure as number });
    }
    return original(input, options);
  });
  const packet = schoolPacketSchema.parse(await collectEsSchool("2026-11-09", "2026-11-15"));
  expect(packet.complete).toBe(false); expect(packet.warnings[0]).toContain(code);
  expect(packet.entries[1]).toMatchObject({ text: "Розв’яжи вправу", attachments: 1 });
  expect(JSON.stringify(packet)).not.toContain("PRIVATE_");
});
it("stops scheduling detail reads after a rate limit instead of hammering the service", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!; let detailCalls = 0;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/Appointment")) return Response.json({ Items: [{ Id: 300, Subject: "Математика", Date: "2026-11-11", Embed: { TargetHomeworks: Array.from({ length: 20 }, (_, i) => ({ Id: 400 + i, Description: "Текст завдання" })) } }] });
    if (url.pathname.includes("/Homework/")) { detailCalls++; return new Response("{}", { status: 429 }); }
    return original(input, options);
  });
  const packet = schoolPacketSchema.parse(await collectEsSchool("2026-11-09", "2026-11-15"));
  expect(detailCalls).toBeLessThanOrEqual(3); expect(packet.warnings).toHaveLength(20);
  expect(packet.entries.filter(item => item.kind === "homework")).toHaveLength(20);
});
