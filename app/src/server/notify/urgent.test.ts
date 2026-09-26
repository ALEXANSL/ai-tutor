import { describe, expect, it } from "vitest";
import { buildUrgentMessage } from "./urgent";

/**
 * US-11.7 КП-2: the external message content is minimal — category, time,
 * mode, a link — and NEVER a quote, nickname, tutor name or e-mail.
 */
describe("buildUrgentMessage", () => {
  it("contains category, time and mode, and never a quote/nickname", () => {
    const msg = buildUrgentMessage("self_harm", "friend_chat", new Date("2026-10-01T10:00:00Z"), false, "Europe/Kyiv");
    expect(msg).toContain("ТЕРМІНОВО");
    expect(msg).toContain("самоушкодження");
    expect(msg).toContain("ШІ-друг");
    expect(msg).not.toMatch(/Зірочка|мама|тато|@/i);
  });

  it("marks a test notification distinctly", () => {
    const msg = buildUrgentMessage("test", "lesson", new Date(), true, "Europe/Kyiv");
    expect(msg).toContain("ТЕСТ");
    expect(msg).not.toContain("ТЕРМІНОВО —");
  });

  it("formats the time in the given time zone, not a hard-coded one (NFR-PLAT-7)", () => {
    const kyiv = buildUrgentMessage("fear", "lesson", new Date("2026-06-01T10:00:00Z"), false, "Europe/Kyiv");
    const other = buildUrgentMessage("fear", "lesson", new Date("2026-06-01T10:00:00Z"), false, "UTC");
    expect(kyiv).not.toBe(other);
  });
});
