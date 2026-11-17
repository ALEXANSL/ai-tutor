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
      const capacity = pages.length === 0 && slide.visual ? 8 : 11;
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
  const accents = ["2563EB", "0D9488", "7C3AED", "C2410C", "BE185D"];
  for (const [index, item] of slides.entries()) {
    const slide = pptx.addSlide();
    const cover = index === 0 && slides.length > 2 && !item.visual && !item.table;
    const closing = index === slides.length - 1 && slides.length > 2 && !item.visual && !item.table;
    const ink = "17243D", accent = accents[index % accents.length]!;
    slide.background = { color: "F4F7FB" };
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: cover ? 1.2 : 0.92, w: 0.7, h: 0.075, fill: { color: accent }, line: { transparency: 100 } });
    slide.addText(work.subject, { x: 0.65, y: 0.34, w: 11.8, h: 0.3, fontSize: 11, bold: true, charSpacing: 2, color: "64748B", margin: 0 });
    slide.addText(item.title, { x: 0.65, y: cover ? 1.6 : 1.1, w: cover ? 11.6 : 12, h: cover ? 2.5 : 0.65, fontSize: cover ? 42 : 28, bold: true, color: ink, margin: 0, valign: "middle", fit: "shrink" });
    if (cover) {
      slide.addText(item.bullets.join("\n\n"), { x: 0.7, y: 4.35, w: 10.5, h: 1.7, fontSize: 22, color: "334155", margin: 0, fit: "shrink" });
      slide.addShape(pptx.ShapeType.ellipse, { x: 11.6, y: 5.2, w: 1.1, h: 1.1, fill: { color: "0D9488" }, line: { transparency: 100 } });
    } else if (item.table) {
      if (item.bullets.length) slide.addText(item.bullets.join(" "), { x: 0.7, y: 1.95, w: 11.8, h: 0.5, fontSize: 17, color: "475569", margin: 0, fit: "shrink" });
      slide.addTable([item.table.columns.map(text => ({ text, options: { bold: true, color: "FFFFFF", fill: { color: accent } } })), ...item.table.rows.map((row, i) => row.map(text => ({ text, options: { fill: { color: i % 2 ? "E8EEF6" : "FFFFFF" } } })))], { x: 0.65, y: 2.65, w: 12, h: 3.9, fontFace: "Aptos", fontSize: 16, color: "17243D", border: { color: "D2DCE8", pt: 1 }, margin: 0.12, autoPage: false });
    } else if (item.visual) {
      const visual = item.visual;
      if (visual.kind === "chart") {
        slide.addImage({ data: `image/png;base64,${(await homeworkVisualPng(visual)).toString("base64")}`, x: 0.6, y: 2.05, w: 8.4, h: 3.78, altText: `${visual.title}. ${visual.caption}` });
      } else {
        const compact = visual.items.length >= 4;
        const cardW = 8.15, cardH = Math.min(1.45, 4.2 / visual.items.length - 0.1);
        slide.addText(visual.title, { x: 0.7, y: 1.95, w: 8.05, h: 0.45, fontSize: 18, bold: true, color: accent, margin: 0, fit: "shrink" });
        for (const [i, node] of visual.items.entries()) {
          const x = 0.65, y = 2.6 + i * (cardH + 0.1), color = accents[i % accents.length]!;
          slide.addShape(pptx.ShapeType.roundRect, { x, y, w: cardW, h: cardH, fill: { color: "FFFFFF" }, line: { color: "DCE5EF", width: 1 } });
          slide.addShape(pptx.ShapeType.ellipse, { x: x + 0.15, y: y + 0.16, w: 0.32, h: 0.32, fill: { color }, line: { transparency: 100 } });
          slide.addText(String(i + 1), { x: x + 0.15, y: y + 0.16, w: 0.32, h: 0.32, color: "FFFFFF", align: "center", valign: "middle", fontSize: 12, bold: true, margin: 0 });
          slide.addText(node.label, { x: x + 0.6, y: y + 0.13, w: compact ? 2.2 : cardW - 0.8, h: compact ? cardH - 0.25 : 0.42, fontSize: compact ? 17 : 20, bold: true, color, margin: 0, fit: "shrink" });
          slide.addText(node.detail, { x: x + (compact ? 3 : 0.22), y: y + (compact ? 0.12 : 0.65), w: compact ? cardW - 3.2 : cardW - 0.44, h: cardH - (compact ? 0.24 : 0.75), fontSize: 16, color: "334155", margin: 0, valign: "top", fit: "shrink" });
        }
      }
      slide.addShape(pptx.ShapeType.roundRect, { x: 9.05, y: 2.05, w: 3.6, h: 4.7, fill: { color: "E4EDF8" }, line: { transparency: 100 } });
      slide.addText("КЛЮЧОВА ДУМКА", { x: 9.3, y: 2.3, w: 3.1, h: 0.35, fontSize: 12, bold: true, color: accent, margin: 0 });
      slide.addText(item.bullets.join("\n\n"), { x: 9.3, y: 2.95, w: 3.1, h: 3.1, fontSize: 19, color: "17243D", margin: 0, valign: "top", fit: "shrink" });
    } else {
      const gap = 0.18, rowH = Math.min(1.45, 4.6 / Math.max(1, item.bullets.length) - gap);
      for (const [i, bullet] of item.bullets.entries()) {
        const y = 2.05 + i * (rowH + gap);
        slide.addShape(pptx.ShapeType.roundRect, { x: 0.65, y, w: 12, h: rowH, fill: { color: closing ? "E3F4EF" : "FFFFFF" }, line: { color: "DCE5EF", width: 1 } });
        slide.addText(String(i + 1).padStart(2, "0"), { x: 0.9, y: y + 0.2, w: 0.65, h: rowH - 0.35, fontSize: 24, bold: true, color: accent, margin: 0, valign: "middle" });
        slide.addText(bullet, { x: 1.85, y: y + 0.17, w: 10.3, h: rowH - 0.32, fontSize: 23, color: ink, margin: 0, valign: "middle", fit: "shrink" });
      }
    }
    slide.addShape(pptx.ShapeType.rect, { x: 0.65, y: 6.95, w: 12 * (index + 1) / slides.length, h: 0.035, fill: { color: accent }, line: { transparency: 100 } });
    slide.addText(`${work.result?.quality?.status === "draft" ? "ЧЕРНЕТКА · " : ""}${work.subject} · ${index + 1} / ${slides.length}`, { x: 0.7, y: 7.1, w: 12, h: 0.2, fontSize: 10, color: "64748B", margin: 0 });
    slide.addNotes(`${item.notes}\n${item.visual ? `${item.visual.caption}\n${item.visual.items.map(node => `${node.label}: ${node.detail}`).join("\n")}` : ""}\n${index === slides.length - 1 ? [...artifact.studyTips, provenance(work)].join("\n") : ""}`);
  }
  return new Uint8Array(await pptx.write({ outputType: "uint8array" }) as Uint8Array);
}
