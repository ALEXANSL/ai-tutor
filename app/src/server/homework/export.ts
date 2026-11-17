import "server-only";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Footer, PageNumber, Table, TableRow, TableCell, WidthType, ImageRun, ShadingType } from "docx";
import pptxgen from "pptxgenjs";
import { homeworkVisualPng } from "./visual-image";
import type { HomeworkWork, HomeworkTable, HomeworkResult } from "@/lib/homework";
type Slide = NonNullable<HomeworkResult["artifact"]>["slides"][number];
function provenance(work: HomeworkWork): string {
  const pages = [...new Set(work.turns.flatMap(turn => turn.pages))];
  return `Навчальний контекст: ${work.subject}. ${work.lessonTitle}.${pages.length ? ` Використані у діалозі сторінки: ${pages.join(", ")}.` : ""} Додаткові пояснення підготовлено за допомогою ШІ; зовнішні джерела автоматично не перевірялися.`;
}
export function paginateSlides(slides: Slide[]) {
  const layouts = slides.flatMap(slide => {
    if (!slide.table) return [slide];
    const table = slide.table, rowPages: string[][][] = []; let rows: string[][] = [], used = 0;
    const width = Math.floor(100 / table.columns.length);
    for (const row of table.rows) {
      const weight = Math.max(...row.map(cell => Math.ceil(cell.length / width))) + 1;
      if (rows.length && used + weight > 13) { rowPages.push(rows); rows = []; used = 0; }
      rows.push(row); used += weight;
    }
    if (rows.length) rowPages.push(rows);
    const separate = !!slide.visual || slide.bullets.length > 2 || slide.bullets.join(" ").length > 120;
    return [...(separate ? [{ ...slide, table: null }] : []), ...rowPages.map((rows, index) => ({ ...slide, title: index ? `${table.title} — продовження` : slide.title, bullets: separate ? [table.title] : slide.bullets, visual: null, table: { ...table, rows } }))];
  });
  return layouts.flatMap(slide => {
    const pages: string[][] = []; let current: string[] = []; let lines = 0;
    for (const bullet of slide.bullets) {
      const weight = Math.ceil(bullet.length / 65) + 1;
      const capacity = pages.length === 0 && slide.visual ? 4 : 11;
      if (current.length && lines + weight > capacity) { pages.push(current); current = []; lines = 0; }
      current.push(bullet); lines += weight;
    }
    if (current.length) pages.push(current);
    return pages.map((bullets, index) => ({ ...slide, title: `${slide.title}${index ? " — продовження" : ""}`, bullets, visual: index ? null : slide.visual, table: index ? null : slide.table, notes: index ? `Продовження слайда «${slide.title}».\n${slide.notes}` : slide.notes }));
  });
}
function docTable(table: HomeworkTable) {
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [table.columns, ...table.rows].map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map(value => new TableCell({ shading: { type: ShadingType.CLEAR, fill: index === 0 ? "17243D" : index % 2 ? "F1F5F9" : "FFFFFF" }, children: [new Paragraph({ children: [new TextRun({ text: value, bold: index === 0, color: index === 0 ? "FFFFFF" : "17243D", size: 22 })], spacing: { before: 100, after: 100 } })] })) })) });
}
export async function exportHomework(work: HomeworkWork, format: "docx" | "pptx"): Promise<Uint8Array> {
  const artifact = work.result?.artifact;
  if (!artifact) throw new Error("Спочатку підготуй документ або презентацію.");
  if (format === "docx") {
    if (!artifact.sections.length) throw new Error("Попроси репетитора підготувати версію для Word.");
    const children: (Paragraph | Table)[] = [new Paragraph({ text: artifact.title, heading: HeadingLevel.TITLE, spacing: { after: 260 } }), ...(artifact.subtitle ? [new Paragraph({ text: artifact.subtitle, spacing: { after: 280 } })] : [])];
    if (work.result?.quality?.status === "draft") children.push(new Paragraph({ text: "ЧЕРНЕТКА — потребує доповнення", heading: HeadingLevel.HEADING_2 }), ...work.result.quality.issues.map(text => new Paragraph({ text })));
    for (const section of artifact.sections) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, keepNext: true }));
      for (const paragraph of section.paragraphs) for (const line of paragraph.split(/\n/).filter(Boolean)) children.push(new Paragraph({ text: line, spacing: { after: 160, line: 330 } }));
      for (const table of section.tables ?? []) children.push(new Paragraph({ text: table.title, heading: HeadingLevel.HEADING_2, keepNext: true }), docTable(table));
      for (const visual of section.visuals ?? []) {
        children.push(new Paragraph({ children: [new ImageRun({ type: "png", data: await homeworkVisualPng(visual), transformation: { width: 600, height: 270 }, altText: { title: visual.title, description: visual.caption, name: visual.title } })] }), new Paragraph({ text: visual.caption, spacing: { after: 150 } }), ...visual.items.filter(item => item.detail).map(item => new Paragraph({ children: [new TextRun({ text: `${item.label}: `, bold: true }), new TextRun(item.detail)], spacing: { after: 80 } })));
      }
    }
    if (artifact.studyTips.length) children.push(new Paragraph({ text: "Як пояснити роботу своїми словами", heading: HeadingLevel.HEADING_1 }), ...artifact.studyTips.map(text => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 100 } })));
    children.push(new Paragraph({ children: [new TextRun({ text: provenance(work), italics: true, size: 18, color: "64748B" })], spacing: { before: 300 } }));
    const doc = new Document({ creator: "ШІ-Репетитор", title: artifact.title, styles: { default: { document: { run: { font: "Calibri", size: 24 } } } }, sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1417, right: 1134 } } }, footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT] })] })] }) }, children }] });
    return new Uint8Array(await Packer.toBuffer(doc));
  }
  if (!artifact.slides.length) throw new Error("Попроси репетитора підготувати версію для PowerPoint.");
  const pptx = new pptxgen(); pptx.layout = "LAYOUT_WIDE"; pptx.author = "ШІ-Репетитор"; pptx.subject = work.subject; pptx.title = artifact.title; pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };
  const slides = paginateSlides(artifact.slides);
  for (const [index, item] of slides.entries()) {
    const slide = pptx.addSlide(); slide.background = { color: "F4F7FB" };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 1.35, fill: { color: "17243D" }, line: { color: "17243D" } });
    slide.addText(item.title, { x: 0.65, y: 0.21, w: 12, h: 0.93, fontSize: 28, bold: true, color: "FFFFFF", margin: 0, valign: "middle", fit: "shrink" });
    let y = item.visual ? 5.65 : item.table ? 1.5 : 1.8;
    const w = 11.4;
    if (item.visual) {
      slide.addImage({ data: `image/png;base64,${(await homeworkVisualPng(item.visual)).toString("base64")}`, x: 2.28, y: 1.5, w: 8.78, h: 3.95, altText: `${item.visual.title}. ${item.visual.caption}` });
    }
    if (item.table) slide.addTable([item.table.columns.map(text => ({ text, options: { bold: true, color: "FFFFFF", fill: "17243D" } })), ...item.table.rows.map(row => row.map(text => ({ text })))], { x: 0.9, y: 2.25, w: 11.4, h: 4.5, fontFace: "Aptos", fontSize: 15, color: "17243D", border: { color: "CBD5E1", pt: 1 }, margin: 0.07, autoPage: false });
    for (const bullet of item.bullets) {
      const h = (Math.ceil(bullet.length / 65) + 1) * (item.visual || item.table ? 0.18 : 0.32);
      slide.addText(bullet, { x: 0.9, y, w, h, fontSize: item.visual || item.table ? 16 : 21, color: "17243D", margin: 0, valign: "top", bullet: { indent: 20 }, paraSpaceAfter: 10, fit: "shrink" }); y += h;
    }
    slide.addText(`${work.result?.quality?.status === "draft" ? "ЧЕРНЕТКА · " : ""}${work.subject} · ${index + 1} / ${slides.length}`, { x: 0.7, y: 7.05, w: 12, h: 0.2, fontSize: 10, color: "64748B", margin: 0 });
    slide.addNotes(`${item.notes}\n${item.visual ? `${item.visual.caption}\n${item.visual.items.map(node => `${node.label}: ${node.detail}`).join("\n")}` : ""}\n${index === slides.length - 1 ? [...artifact.studyTips, provenance(work)].join("\n") : ""}`);
  }
  return new Uint8Array(await pptx.write({ outputType: "uint8array" }) as Uint8Array);
}
