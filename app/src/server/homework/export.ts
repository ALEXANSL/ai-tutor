import "server-only";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber } from "docx";
import pptxgen from "pptxgenjs";
import type { HomeworkWork } from "@/lib/homework";

function provenance(work: HomeworkWork): string {
  const pages = [...new Set(work.turns.flatMap(turn => turn.pages))];
  return `Навчальний контекст: ${work.subject}. ${work.lessonTitle}.${pages.length ? ` Використані у діалозі сторінки: ${pages.join(", ")}.` : ""} Додаткові пояснення підготовлено за допомогою ШІ; зовнішні джерела автоматично не перевірялися.`;
}
export function paginateSlides(slides: { title: string; bullets: string[]; notes: string }[]) {
  return slides.flatMap(slide => {
    const pages: string[][] = []; let current: string[] = []; let lines = 0;
    for (const bullet of slide.bullets) {
      const weight = Math.ceil(bullet.length / 65) + 1;
      if (current.length && lines + weight > 11) { pages.push(current); current = []; lines = 0; }
      current.push(bullet); lines += weight;
    }
    if (current.length) pages.push(current);
    return pages.map((bullets, index) => ({ title: `${slide.title}${index ? " — продовження" : ""}`, bullets, notes: index ? `Продовження слайда «${slide.title}».` : slide.notes }));
  });
}
export async function exportHomework(work: HomeworkWork, format: "docx" | "pptx"): Promise<Uint8Array> {
  const artifact = work.result?.artifact;
  if (!artifact) throw new Error("Спочатку підготуй документ або презентацію.");
  if (format === "docx") {
    if (!artifact.sections.length) throw new Error("Попроси репетитора підготувати версію для Word.");
    const paragraphs: Paragraph[] = [new Paragraph({ text: artifact.title, heading: HeadingLevel.TITLE }), ...(artifact.subtitle ? [new Paragraph({ text: artifact.subtitle, spacing: { after: 280 } })] : [])];
    for (const section of artifact.sections) {
      paragraphs.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
      for (const paragraph of section.paragraphs) for (const line of paragraph.split(/\n/).filter(Boolean)) paragraphs.push(new Paragraph({ text: line, spacing: { after: 160, line: 330 } }));
    }
    if (artifact.studyTips.length) paragraphs.push(new Paragraph({ text: "Як пояснити роботу своїми словами", heading: HeadingLevel.HEADING_1 }), ...artifact.studyTips.map(text => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 100 } })));
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: provenance(work), italics: true, size: 18, color: "64748B" })], spacing: { before: 300 } }));
    const doc = new Document({ creator: "ШІ-Репетитор", title: artifact.title, styles: { default: { document: { run: { font: "Calibri", size: 24 } } } }, sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1417, right: 1134 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT] })] })] }) }, children: paragraphs }] });
    return new Uint8Array(await Packer.toBuffer(doc));
  }
  if (!artifact.slides.length) throw new Error("Попроси репетитора підготувати версію для PowerPoint.");
  const pptx = new pptxgen(); pptx.layout = "LAYOUT_WIDE"; pptx.author = "ШІ-Репетитор"; pptx.subject = work.subject; pptx.title = artifact.title;
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };
  const slides = paginateSlides(artifact.slides);
  for (const [index, item] of slides.entries()) {
    const slide = pptx.addSlide(); slide.background = { color: "F4F7FB" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 1.5, fill: { color: "17243D" }, line: { color: "17243D" } });
    slide.addShape(pptx.ShapeType.rect, { x: 0.55, y: 1.73, w: 0.08, h: 4.7, fill: { color: "14B8A6" }, line: { color: "14B8A6" } });
    slide.addText(item.title, { x: 0.65, y: 0.24, w: 12, h: 1.03, fontSize: 29, bold: true, color: "FFFFFF", margin: 0, breakLine: false, valign: "middle", fit: "shrink" });
    let y = 1.9;
    for (const bullet of item.bullets) {
      const h = (Math.ceil(bullet.length / 65) + 1) * 0.32;
      slide.addText(bullet, { x: 0.9, y, w: 11.4, h, fontSize: 21, color: "17243D", margin: 0, valign: "top", bullet: { indent: 20 }, paraSpaceAfter: 12, fit: "shrink" });
      y += h;
    }
    slide.addText(`${work.subject} · ${index + 1} / ${slides.length}`, { x: 0.7, y: 7.05, w: 12, h: 0.2, fontSize: 10, color: "64748B", margin: 0 });
    slide.addNotes(`${item.notes}\n\n${index === slides.length - 1 ? [...artifact.studyTips, provenance(work)].join("\n") : ""}`);
  }
  return new Uint8Array(await pptx.write({ outputType: "uint8array" }) as Uint8Array);
}
