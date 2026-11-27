import "server-only";
import pptxgen from "pptxgenjs";
import sharp from "sharp";
import { type LessonSlidePlan } from "@/lib/lesson-slide-plan";
import { commonsPictures, downloadCommonsPicture, normaliseIllustration } from "@/server/studio/illustrations";

const palette = { ink: "243C42", teal: "237F79" };
type Picture = { bytes: Buffer; credit: string };
export async function slidePicture(query: string): Promise<Picture | undefined> {
  if (!query.trim()) return;
  try {
    const matches = await commonsPictures(query);
    const image = matches.find(p => /^(public domain|cc0|cc by(?:-sa)? [\d.]+)$/i.test(p.license));
    if (!image) return;
    const bytes = await normaliseIllustration(await downloadCommonsPicture(image.url));
    return { bytes, credit: [image.title, image.credit, image.license, image.sourceUrl].filter(Boolean).join(" · ") };
  } catch { return; } // The slide then keeps a text-only layout.
}

/** Lays out a generated deck. `pictures[i]` holds the stored picture of slide i (ADR-050);
 * a slide without one gets a wide text layout instead of decorative shapes. */
export async function buildLessonPptx(title: string, plan: LessonSlidePlan, pictures: (Buffer | undefined)[] = []) {
  const deck = new pptxgen();
  deck.layout = "LAYOUT_WIDE";
  deck.title = title;
  deck.author = "ШІ-Репетитор";
  for (const [i, s] of plan.slides.entries()) {
    const page = deck.addSlide();
    page.background = { color: "FAF6EB" };
    const text = (value: string, x: number, y: number, w: number, h: number, size: number, bold = false) =>
      page.addText(value, { x, y, w, h, fontFace: "Aptos", color: palette.ink, fontSize: size, bold, margin: 0, fit: "shrink", valign: "middle", breakLine: false });
    const bytes = pictures[i];
    const visual = s.visual;
    if (bytes) {
      const visualLeft = i % 2 === 1;
      const x = visualLeft ? 0.55 : 6.62;
      const tx = visualLeft ? 7.02 : 0.68;
      page.addShape(deck.ShapeType.rect, { x: tx, y: 0.75, w: 0.85, h: 0.09, fill: { color: palette.teal }, line: { transparency: 100 } });
      text(s.heading, tx, 1.04, 5.56, 1.65, 36, true);
      text(s.takeaway, tx, 2.96, 5.56, 2.72, 23);
      page.addShape(deck.ShapeType.roundRect, { x, y: 0.75, w: 6.1, h: 5.43, fill: { color: "EBEFE3" }, line: { transparency: 100 } });
      const { width, height } = await sharp(bytes).metadata();
      const scale = Math.min(5.95 / width!, 5.28 / height!);
      const w = width! * scale, h = height! * scale;
      const ix = x + (6.1-w)/2, iy = 0.75 + (5.43-h)/2;
      page.addImage({ data: "image/jpeg;base64," + bytes.toString("base64"), x: ix, y: iy, w, h, altText: s.caption });
      // ADR-051: map labels are slide text next to each marker, never letters inside the picture.
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      for (const label of visual?.kind === "map" ? visual.labels ?? [] : []) {
        const lw = Math.min(2.8, 0.25 + label.name.length * 0.12), lh = 0.36;
        const dx = ix + label.x * w, dy = iy + label.y * h;
        const lx = dx + 0.16 + lw <= ix + w ? dx + 0.16 : Math.max(ix, dx - 0.16 - lw);
        let ly = Math.min(Math.max(dy - lh / 2, iy), iy + h - lh);
        const hits = (y: number) => placed.some(b => lx < b.x + b.w && b.x < lx + lw && y < b.y + b.h && b.y < y + lh);
        for (const step of [0.4, -0.4, 0.8, -0.8]) { if (!hits(ly)) break; const next = ly + step; if (next >= iy && next + lh <= iy + h && !hits(next)) ly = next; }
        placed.push({ x: lx, y: ly, w: lw, h: lh });
        page.addText(label.name, { x: lx, y: ly, w: lw, h: lh, fontFace: "Aptos", fontSize: 14, bold: true, color: palette.ink, align: "center", valign: "middle", margin: 0, fit: "shrink", fill: { color: "FFFFFF", transparency: 12 } });
      }
      text(s.caption, x, 6.18, 6.1, 0.56, 14);
      const label = visual?.kind === "photo" ? "Фото · " + (visual.credit ?? "") : visual?.credit ?? "";
      if (label.trim()) page.addText(label, {
        x: 0.65, y: 6.95, w: 10.5, h: 0.3, margin: 0, fontSize: 9, color: palette.ink, fit: "shrink",
        ...(visual?.kind === "photo" && visual.sourceUrl ? { hyperlink: { url: visual.sourceUrl } } : {}),
      });
    } else {
      page.addShape(deck.ShapeType.rect, { x: 0.68, y: 0.75, w: 0.85, h: 0.09, fill: { color: palette.teal }, line: { transparency: 100 } });
      text(s.heading, 0.68, 1.04, 11.9, 1.5, 38, true);
      text(s.takeaway, 0.68, 2.8, 11.9, 3.4, 26);
    }
    text(String(i+1) + " / " + plan.slides.length, 11.76, 6.96, 0.97, 0.3, 11);
    page.addNotes([s.narration, ...(visual?.kind === "photo" && bytes ? [[visual.credit, visual.sourceUrl].filter(Boolean).join(" · ")] : [])].join("\n\n"));
  }
  return Buffer.from(await deck.write({ outputType: "nodebuffer" }) as Buffer);
}
