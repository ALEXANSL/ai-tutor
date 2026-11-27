import { describe, expect, it } from "vitest";
import { fitRect, pickRecorderType, totalSeconds, videoFileName } from "./deckVideo";

describe("deck video export helpers (ADR-049)", () => {
  it("prefers MP4 and falls back to WebM", () => {
    expect(pickRecorderType(t => t === "video/mp4")).toEqual({ mimeType: "video/mp4", extension: "mp4" });
    expect(pickRecorderType(t => t.startsWith("video/webm"))?.extension).toBe("webm");
    expect(pickRecorderType(() => false)).toBeNull();
  });
  it("letterboxes a 4:3 slide into a 16:9 frame", () => {
    expect(fitRect(1024, 768, 1280, 720)).toEqual({ x: 160, y: 0, w: 960, h: 720 });
    expect(fitRect(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });
  it("builds a safe file name and total length", () => {
    expect(videoFileName('Дроби: "скорочення"/повтор', "mp4")).toBe("Дроби скорочення повтор.mp4");
    expect(videoFileName("   ", "webm")).toBe("videourok.webm");
    expect(totalSeconds([10, 20.5], 0.5)).toBe(31.5);
  });
});
