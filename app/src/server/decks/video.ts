import "server-only";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import type { NarratedDeck } from "@/lib/narrated-deck";
import { createServiceClient } from "@/server/supabase/clients";
import { signedAudioUrl } from "@/server/audiobooks/storage";
import { audioHash } from "@/server/audiobooks/text";
import { pdfPath } from "./store";
import { concatList, segmentArgs, VIDEO_HEIGHT, VIDEO_WIDTH } from "./video-args";

/**
 * Server-side MP4 of a narrated deck (ADR-049, rev. 2026-11-27): slide images
 * rendered from the deck's own PDF, sound from its cached narration, glued by
 * ffmpeg in a background job. No AI call and no paid service; the parent only
 * downloads the finished file.
 */
export const VIDEO_BUCKET = "video_lessons";
export const videoPath = (family: string, id: string) => `${family}/presentations/${id}/lesson.mp4`;

const run = promisify(execFile);

/** Absolute path of the bundled ffmpeg binary, or null where this function was deployed without it. */
export function ffmpegBinary(): string | null {
  const path = ffmpegPath as unknown as string | null;
  return path && existsSync(path) ? path : null;
}

async function slideImages(pdf: Uint8Array): Promise<Buffer[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Only the presentation queue function bundles the native canvas (next.config.ts).
  const { createCanvas } = await import("@napi-rs/canvas").catch(() => { throw new VideoToolMissing(); });
  const task = pdfjs.getDocument({ data: pdf, disableFontFace: true, standardFontDataUrl: join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts") + "/" });
  const doc = await task.promise;
  const images: Buffer[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(VIDEO_WIDTH / base.width, VIDEO_HEIGHT / base.height) * 1.5 });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      images.push(await canvas.encode("png"));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return images;
}

/** Renders the whole deck to MP4 and stores it; returns the stored size in bytes. */
export async function renderDeckVideo(family: string, id: string, deck: NarratedDeck): Promise<number> {
  const ffmpeg = ffmpegBinary();
  if (!ffmpeg) throw new VideoToolMissing();
  const db = createServiceClient();
  const file = await db.storage.from("course_assets").download(pdfPath(family, id));
  if (file.error || !file.data) throw new Error("Не вдалося прочитати слайди презентації.");
  const images = await slideImages(new Uint8Array(await file.data.arrayBuffer()));
  if (images.length !== deck.slides.length) throw new Error("Кількість слайдів не збігається з озвученням.");
  const dir = await mkdtemp(join(tmpdir(), "deck-video-"));
  try {
    const segments: string[] = [];
    for (let i = 0; i < deck.slides.length; i++) {
      const slide = deck.slides[i]!;
      const audio = await fetch(await signedAudioUrl(family, id, audioHash(slide.narration)), { signal: AbortSignal.timeout(30_000) });
      if (!audio.ok) throw new Error(`Не вдалося прочитати озвучку слайда ${i + 1}.`);
      const image = join(dir, `s${i}.png`), sound = join(dir, `a${i}.mp3`), segment = join(dir, `v${i}.mp4`);
      await writeFile(image, images[i]!);
      await writeFile(sound, Buffer.from(await audio.arrayBuffer()));
      await run(ffmpeg, segmentArgs(image, sound, segment), { timeout: 120_000 });
      segments.push(segment);
    }
    const list = join(dir, "list.txt"), output = join(dir, "lesson.mp4");
    await writeFile(list, concatList(segments));
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output], { timeout: 120_000 });
    const bytes = await readFile(output);
    const saved = await db.storage.from(VIDEO_BUCKET).upload(videoPath(family, id), bytes, { contentType: "video/mp4", upsert: true });
    if (saved.error) throw new Error("Не вдалося зберегти відео у сховищі.");
    return bytes.length;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function signedVideoUrl(family: string, id: string, title: string) {
  const { data, error } = await createServiceClient().storage.from(VIDEO_BUCKET).createSignedUrl(videoPath(family, id), 300, { download: `${title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "videourok"}.mp4` });
  if (error || !data) throw new Error("Відео недоступне.");
  return data.signedUrl;
}

/** This function was deployed without ffmpeg; the dedicated queue function will pick the job up. */
export class VideoToolMissing extends Error {
  constructor() { super("ffmpeg or canvas is not bundled in this function"); }
}
