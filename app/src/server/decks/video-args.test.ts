import { expect, it } from "vitest";
import { concatList, segmentArgs } from "./video-args";

it("builds a still-image segment that lasts as long as the narration plus a pause", () => {
  const args = segmentArgs("/t/s0.png", "/t/a0.mp3", "/t/v0.mp4");
  expect(args).toContain("-shortest");
  expect(args).toContain("stillimage");
  expect(args.join(" ")).toContain("apad=pad_dur=0.6");
  expect(args.at(-1)).toBe("/t/v0.mp4");
});
it("writes a concat list with escaped quotes", () => {
  expect(concatList(["/t/v0.mp4", "/t/it's.mp4"])).toBe("file '/t/v0.mp4'\nfile '/t/it'\\''s.mp4'\n");
});
