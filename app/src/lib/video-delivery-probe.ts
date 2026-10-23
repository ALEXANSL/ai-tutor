export interface VideoDeliveryProbe {
  status: number | null;
  bytes: number;
  elapsedMs: number;
  headersMs: number | null;
  mbps: number;
  partialResponse: boolean;
  contentRange: string | null;
  contentType: string | null;
  acceptRanges: string | null;
  mp4Metadata: "before-media" | "after-media" | "unknown";
  error: "timeout" | "aborted" | "network-or-cors" | "http" | null;
}
const SAMPLE_BYTES = 1024 * 1024;
/** Inspect box headers only, never executable content or text from the video. */
export function mp4MetadataOrder(bytes: Uint8Array): VideoDeliveryProbe["mp4Metadata"] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    let length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "moov") return "before-media";
    if (type === "mdat") return "after-media";
    if (length === 1) {
      if (offset + 16 > bytes.byteLength) return "unknown";
      const extended = view.getBigUint64(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return "unknown";
      length = Number(extended);
    }
    if (length < 8) return "unknown";
    offset += length;
  }
  return "unknown";
}
/** Bounded sample, never a full-file download if the origin ignores Range.
 * Return allowlisted metrics only: no URL, token, request headers or errors
 * that might contain a signed URL. Also used on Vercel for a second vantage. */
export async function probeVideoDelivery(url: string, signal?: AbortSignal): Promise<VideoDeliveryProbe> {
  const controller = new AbortController();
  let timeout = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, 12000);
  const started = performance.now();
  const report: VideoDeliveryProbe = { status: null, bytes: 0, elapsedMs: 0, headersMs: null, mbps: 0, partialResponse: false, contentRange: null, contentType: null, acceptRanges: null, mp4Metadata: "unknown", error: null };
  try {
    const response = await fetch(url, { headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}` }, signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error" });
    report.headersMs = Math.round(performance.now() - started);
    report.status = response.status;
    report.partialResponse = response.status === 206;
    report.contentRange = response.headers.get("content-range")?.slice(0, 120) ?? null;
    report.contentType = response.headers.get("content-type")?.slice(0, 120) ?? null;
    report.acceptRanges = response.headers.get("accept-ranges")?.slice(0, 40) ?? null;
    if (!response.ok) { report.error = "http"; return report; }
    const reader = response.body?.getReader();
    if (!reader) { report.error = "network-or-cors"; return report; }
    const sample = new Uint8Array(SAMPLE_BYTES);
    try {
      while (report.bytes < SAMPLE_BYTES) {
        const result = await reader.read();
        if (result.done) break;
        const part = result.value.subarray(0, SAMPLE_BYTES - report.bytes);
        sample.set(part, report.bytes); report.bytes += part.length;
        if (report.mp4Metadata === "unknown") report.mp4Metadata = mp4MetadataOrder(sample.subarray(0, report.bytes));
      }
      report.mp4Metadata = mp4MetadataOrder(sample.subarray(0, report.bytes));
    } finally { void reader.cancel().catch(() => {}); }
  } catch {
    report.error = timeout ? "timeout" : signal?.aborted ? "aborted" : "network-or-cors";
  } finally {
    report.elapsedMs = Math.round(performance.now() - started);
    report.mbps = Math.round((report.bytes * 8 / Math.max(1, report.elapsedMs) / 1000) * 100) / 100;
    clearTimeout(timer); signal?.removeEventListener("abort", cancel); controller.abort();
  }
  return report;
}
