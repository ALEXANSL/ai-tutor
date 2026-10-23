import { afterEach, describe, expect, it, vi } from "vitest";
import { mp4MetadataOrder, probeVideoDelivery } from "./video-delivery-probe";
function box(type: string, length = 8) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setUint32(0, length); bytes.set([...type].map(char => char.charCodeAt(0)), 4); return bytes; }
const secretUrl = "https://example.com/video.mp4?token=PRIVATE";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("bounded delivery probe", () => {
  it("identifies metadata before or after media from top-level box headers", () => {
    expect(mp4MetadataOrder(new Uint8Array([...box("ftyp"), ...box("moov"), ...box("mdat")]))).toBe("before-media");
    expect(mp4MetadataOrder(new Uint8Array([...box("ftyp"), ...box("mdat", 100_000)]))).toBe("after-media");
    expect(mp4MetadataOrder(box("free", 0))).toBe("unknown");
  });
  it("reads a byte range and returns only allowlisted diagnostics", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new Uint8Array([...box("ftyp"), ...box("moov")]), { status: 206, headers: { "content-range": "bytes 0-15/16", "content-type": "video/mp4" } })); vi.stubGlobal("fetch", fetch);
    const result = await probeVideoDelivery(secretUrl);
    expect(result).toMatchObject({ status: 206, bytes: 16, partialResponse: true, mp4Metadata: "before-media", error: null });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { Range: "bytes=0-1048575" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("cancels after at most 1 MiB if the server ignores Range", async () => {
    const cancel = vi.fn(); let chunks = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(256 * 1024)); }, cancel }), { status: 200 })));
    const result = await probeVideoDelivery(secretUrl);
    expect(result.bytes).toBe(1024 * 1024); expect(result.partialResponse).toBe(false); expect(cancel).toHaveBeenCalled(); expect(chunks).toBeLessThan(10);
  });
  it("does not expose transport errors containing a signed URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`failed: ${secretUrl}`); }));
    expect(await probeVideoDelivery(secretUrl)).toMatchObject({ error: "network-or-cors", bytes: 0 });
    expect(JSON.stringify(await probeVideoDelivery(secretUrl))).not.toContain("PRIVATE");
  });
  it("has a finite timeout and cancels its fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort"))))));
    const pending = probeVideoDelivery(secretUrl); await vi.advanceTimersByTimeAsync(12000);
    expect(await pending).toMatchObject({ error: "timeout" });
  });
});
