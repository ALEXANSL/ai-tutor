import "server-only";
import pptxgen from "pptxgenjs";
import sharp from "sharp";
import { type LessonSlidePlan } from "@/lib/lesson-slide-plan";
import { commonsPictures, downloadCommonsPicture, normaliseIllustration } from "@/server/studio/illustrations";

const palette = { ink: "243C42", teal: "237F79", clay: "BF624B", gold: "DDA94D", pale: "C8DFD5" };
type Picture = { bytes: Buffer; credit: string };
export async function slidePicture(query: string): Promise<Picture | undefined> {
  if (!query.trim()) return;
  try {
    const matches = await commonsPictures(query);
    const image = matches.find(p => /^(public domain|cc0|cc by(?:-sa)? [\d.]+)$/i.test(p.license));
    if (!image) return;
    const bytes = await normaliseIllustration(await downloadCommonsPicture(image.url));
    return { bytes, credit: [image.title, image.credit, image.license, image.sourceUrl].filter(Boolean).join(" · ") };
  } catch { return; } // The authored vector illustration is already part of every slide.
}

export async function buildLessonPptx(title: string, plan: LessonSlidePlan) {
  const deck = new pptxgen();
  deck.layout = "LAYOUT_WIDE";
  deck.title = title;
  deck.author = "ШІ-Репетитор";
  const bound = (n: number, max: number) => Math.max(0, Math.min(n, max));
  const pictures: (Picture | undefined)[] = [];
  for (let i = 0; i < plan.slides.length; i += 4) {
    pictures.push(...await Promise.all(plan.slides.slice(i, i + 4).map(s => slidePicture(s.photoQuery))));
  }
  for (const [i, s] of plan.slides.entries()) {
    const page = deck.addSlide();
    page.background = { color: "FAF6EB" };
    const text = (value: string, x: number, y: number, w: number, h: number, size: number, bold = false) =>
      page.addText(value, { x, y, w, h, fontFace: "Aptos", color: palette.ink, fontSize: size, bold, margin: 0, fit: "shrink", valign: "middle", breakLine: false });
    const visualLeft = i % 2 === 1;
    const x = visualLeft ? 0.55 : 6.62;
    const tx = visualLeft ? 7.02 : 0.68;
    page.addShape(deck.ShapeType.rect, { x: tx, y: 0.75, w: 0.85, h: 0.09, fill: { color: palette.teal }, line: { transparency: 100 } });
    text(s.heading, tx, 1.04, 5.56, 1.65, 36, true);
    text(s.takeaway, tx, 2.96, 5.56, 2.72, 23);
    page.addShape(deck.ShapeType.roundRect, { x, y: 0.75, w: 6.1, h: 5.43, fill: { color: "EBEFE3" }, line: { transparency: 100 } });
    const photo = pictures[i];
    if (photo) {
      const { width, height } = await sharp(photo.bytes).metadata();
      const scale = Math.min(5.85 / width!, 5.12 / height!);
      const w = width! * scale, h = height! * scale;
      page.addImage({ data: "image/jpeg;base64," + photo.bytes.toString("base64"), x: x + (6.1-w)/2, y: 0.75 + (5.43-h)/2, w, h, altText: s.caption });
    } else {
      for (const mark of s.drawing) {
        const left = bound(mark.x, 99), top = bound(mark.y, 99);
        const w = bound(mark.width, 100-left), h = bound(mark.height, 100-top);
        const color = palette[mark.color];
        page.addShape(deck.ShapeType[mark.shape], { x: x + 0.15 + left*0.058, y: 0.92 + top*0.05, w: w*0.058, h: h*0.05, fill: { color }, line: { color, width: mark.shape === "line" ? 2 : 0 } });
      }
    }
    text(s.caption, x, 6.18, 6.1, 0.56, 14);
    if (photo) page.addText("Фото · " + photo.credit.split(" · ").slice(0, -1).join(" · "), {
      x: 0.65, y: 6.95, w: 10.5, h: 0.3, margin: 0, fontSize: 9, color: palette.ink,
      fit: "shrink", hyperlink: { url: photo.credit.split(" · ").at(-1)! },
    });
    text(String(i+1) + " / " + plan.slides.length, 11.76, 6.96, 0.97, 0.3, 11);
    page.addNotes([s.narration, ...(photo ? [photo.credit] : [])].join("\n\n"));
  }
  return Buffer.from(await deck.write({ outputType: "nodebuffer" }) as Buffer);
}
