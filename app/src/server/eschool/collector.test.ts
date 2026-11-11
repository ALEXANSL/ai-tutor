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
      : url.pathname.endsWith("/Appointment") ? { Quantity: 1, Items: [{ Id: 300, SubjectId: 10, Subject: "Інформатика", Date: "2026-11-11T00:00:00", Embed: { Topics: [{ Id: 500, Title: "Безпека в мережі" }], TargetHomeworks: [{ Id: 400 }], Teacher: { Email: "PRIVATE_EMAIL" }, Rates: [{ Rate: "PRIVATE_GRADE" }] } }] }
      : { Id: 400, Topic: "Безпека", Description: "<p>Підготуй презентацію<br>7 слайдів &amp; приклади</p>", AppointmentDate: "2026-11-11", TargetAppointmentDate: "2026-11-13", HaveAnswer: true, Embed: { Files: [{ Url: "PRIVATE_URL", Name: "PRIVATE_FILE" }] } };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => vi.unstubAllGlobals());
it("reads only the active pupil through GET requests and exports homework without credentials, names, grades or file URLs", async () => {
  const packet = schoolPacketSchema.parse(await collectEsSchool("2026-11-09", "2026-11-15"));
  expect(packet.entries).toHaveLength(2); expect(packet.entries[1]!.text).toContain("7 слайдів & приклади"); expect(packet.entries[1]!.dueDate).toBe("2026-11-13");
  expect(JSON.stringify(packet)).not.toContain("PRIVATE_"); expect(calls.every(call => call.method === "GET")).toBe(true);
  expect(calls.find(call => call.url.pathname.endsWith("Appointment"))!.url.pathname).toContain("/SchoolBoy/200/"); expect(calls.some(call => call.url.pathname.includes("999"))).toBe(false);
});
it("stops on an expired session or a non-pupil profile instead of guessing another child's ID", async () => {
  denied = true; expect(await collectEsSchool("2026-11-09", "2026-11-15")).toMatchObject({ error: expect.stringContaining("ESCHOOL-LOGIN") });
  denied = false; role = "teacher"; calls.length = 0;
  expect(await collectEsSchool("2026-11-09", "2026-11-15")).toMatchObject({ error: expect.stringContaining("ESCHOOL-PUPIL") }); expect(calls.some(call => call.url.pathname.endsWith("Appointment"))).toBe(false);
});
