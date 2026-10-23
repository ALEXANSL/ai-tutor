import { describe, expect, it } from "vitest";
import { isDirectVideoRequest } from "./direct-video-request";
const media = new URL("https://example.com/storage/v1/object/sign/video_lessons/family/file.mp4?token=private");
describe("native video transport bypasses the app worker", () => {
  it("leaves media, signed video fetches and byte-range requests to the browser", () => {
    expect(isDirectVideoRequest({ destination: "video", headers: new Headers() }, new URL("https://example.com/movie.mp4"))).toBe(true);
    expect(isDirectVideoRequest({ destination: "", headers: new Headers() }, media)).toBe(true);
    expect(isDirectVideoRequest({ destination: "", headers: new Headers({ Range: "bytes=0-1000" }) }, new URL("https://example.com/stream"))).toBe(true);
  });
  it("keeps normal private API/page requests under the network-only policy", () => {
    expect(isDirectVideoRequest({ destination: "", headers: new Headers() }, new URL("https://example.com/api/parent/data"))).toBe(false);
    expect(isDirectVideoRequest({ destination: "document", headers: new Headers() }, new URL("https://example.com/parent"))).toBe(false);
  });
});
