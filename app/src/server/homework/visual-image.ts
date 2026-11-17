import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import opentype, { type Font } from "opentype.js";
import sharp from "sharp";
import { homeworkVisualSvg } from "@/lib/homework-visual";
import type { HomeworkVisual } from "@/lib/homework";
let font: Font | undefined;
const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, key: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[key]!);
/** Font outlines make offline Office diagrams identical on Vercel and local machines. */
export async function homeworkVisualPng(visual: HomeworkVisual) {
  if (!font) { const bytes = readFileSync(join(process.cwd(), "assets/fonts/DejaVuSans.ttf")); font = opentype.parse(Uint8Array.from(bytes).buffer); }
  const outlined = homeworkVisualSvg(visual).replace(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)" fill="(#[a-f\d]+)">([\s\S]*?)<\/text>/gi, (_whole, x, y, size, fill, spans: string) => {
    let baseline = Number(y);
    return [...spans.matchAll(/<tspan x="([\d.]+)" dy="([\d.]+)">([\s\S]*?)<\/tspan>/g)].map(span => { baseline += Number(span[2]); let pen = Number(span[1] || x); const scale = Number(size) / font!.unitsPerEm;
      let previous: ReturnType<Font["charToGlyph"]> | undefined;
      return [...decode(span[3]!)].map(char => { const glyph = font!.charToGlyph(char); if (previous) pen += font!.getKerningValue(previous, glyph) * scale; const path = glyph.getPath(pen, baseline, Number(size)).toPathData(2); pen += (glyph.advanceWidth ?? 0) * scale; previous = glyph; return `<path d="${path}" fill="${fill}"/>`; }).join(""); }).join("");
  });
  return sharp(Buffer.from(outlined)).resize(1600, 720).png().toBuffer();
}
