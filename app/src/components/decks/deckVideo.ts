/**
 * Pure helpers for exporting a narrated deck as a video file in the browser
 * (ADR-049): slides come from the deck's own PDF, sound from its cached
 * per-slide narration. Nothing is sent to any AI provider.
 */

/** Container/codec candidates, MP4 first (plays everywhere), WebM as the Chrome/Firefox fallback. */
export const RECORDER_TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

export function pickRecorderType(isSupported: (type: string) => boolean): { mimeType: string; extension: "mp4" | "webm" } | null {
  for (const type of RECORDER_TYPES) {
    if (isSupported(type)) return { mimeType: type, extension: type.startsWith("video/mp4") ? "mp4" : "webm" };
  }
  return null;
}

/** Largest rectangle with the source aspect ratio that fits, centred (letterboxed). */
export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: dstW, h: dstH };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
  return { x: Math.round((dstW - w) / 2), y: Math.round((dstH - h) / 2), w, h };
}

/** A safe download name in Ukrainian or Latin letters. */
export function videoFileName(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "videourok";
  return `${base}.${extension}`;
}

/** Total length in seconds: every slide's narration plus a short pause after each. */
export function totalSeconds(durations: number[], pause: number): number {
  return durations.reduce((sum, d) => sum + Math.max(0, d) + pause, 0);
}
