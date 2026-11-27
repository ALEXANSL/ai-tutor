/** Pure ffmpeg argument builders for the deck video (ADR-049), unit-tested. */
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
/** Short silence after each slide so the next one does not start mid-breath. */
export const SLIDE_PAUSE_SECONDS = 0.6;

/** One slide: a still image shown for exactly the narration plus a pause, letterboxed to 16:9. */
export function segmentArgs(image: string, audio: string, output: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1", "-framerate", "2", "-i", image,
    "-i", audio,
    "-vf", `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`,
    "-af", `apad=pad_dur=${SLIDE_PAUSE_SECONDS}`,
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-r", "2",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-shortest", output,
  ];
}

/** ffmpeg concat-demuxer list; paths are our own temp files, quotes escaped anyway. */
export function concatList(paths: string[]): string {
  return paths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}
