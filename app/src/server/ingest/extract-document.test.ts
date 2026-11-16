import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { Document, Packer, Paragraph, Table, TableRow, TableCell, HeadingLevel } from "docx";
import PptxGenJS from "pptxgenjs";
import { extractDocument } from "./extract-document";
import { sourceFileFormat, storedSourceFormat } from "@/lib/source-files";

it.each(["pdf", "epub", "docx", "pptx", "txt", "md", "png", "jpeg"])("recognizes generic-MIME %s uploads and stores without a new DB enum", format => {
  const actual = sourceFileFormat({ name: `file.${format}`, mimeType: "application/octet-stream" });
  expect(actual).toBe(format); expect(storedSourceFormat(actual!)).toBe(["pdf", "epub"].includes(format) ? format : "manual");
});
it("rejects an explicit conflicting MIME and does not enable macro or old binary formats", () => {
  expect(sourceFileFormat({ name: "file.docx", mimeType: "application/pdf" })).toBeNull();
  for (const extension of ["doc", "ppt", "docm", "pptm", "exe", "html"]) expect(sourceFileFormat({ name: `file.${extension}`, mimeType: "application/octet-stream" })).toBeNull();
  expect(sourceFileFormat({ name: "photo.JPG", mimeType: "image/jpeg" })).toBe("jpeg");
});
it("extracts a real Word document in paragraph/table order and keeps sections", async () => {
  const doc = new Document({ sections: [{ children: [new Paragraph({ text: "Моя тема", heading: HeadingLevel.HEADING_1 }), new Paragraph("Прочитай український текст & German Grüße."), new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("Слово")] }), new TableCell({ children: [new Paragraph("Переклад")] })] })] }), new Paragraph({ text: "Практика", heading: HeadingLevel.HEADING_2 }), new Paragraph("Обери правильну відповідь.")] }] });
  const result = await extractDocument(new Uint8Array(await Packer.toBuffer(doc)), "docx");
  expect(result.units).toHaveLength(2); expect(result.units[0]!.locator).toBe("Моя тема");
  expect(result.units[0]!.text).toContain("Слово | Переклад"); expect(result.units[0]!.text).toContain("German Grüße.");
  expect(result.units[1]!.text).toContain("Обери правильну відповідь"); expect(result.warnings.join(" ")).toContain("ілюстрації");
});
it("extracts a real PowerPoint including tables in presentation order", async () => {
  const ppt = new PptxGenJS(); ppt.addSlide().addText("Перший слайд", { x: 1, y: 1, w: 5, h: 1 });
  const second = ppt.addSlide(); second.addText("Другий слайд", { x: 1, y: 1, w: 5, h: 1 }); second.addTable([[{ text: "English" }, { text: "Українська" }], [{ text: "book" }, { text: "книга" }]]);
  const data = await ppt.write({ outputType: "nodebuffer" }) as Buffer;
  const result = await extractDocument(new Uint8Array(data), "pptx");
  expect(result.units.map(unit => unit.page)).toEqual([1, 2]); expect(result.units[0]!.text).toContain("Перший");
  expect(result.units[1]!.text).toContain("book | книга");
});
it("uses relationship order rather than numeric slide filenames, omits external relationships and flags image-only slides", async () => {
  const bytes = zipSync({
    "ppt/presentation.xml": strToU8('<p:presentation><p:sldIdLst><p:sldId r:id="r9"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>'),
    "ppt/_rels/presentation.xml.rels": strToU8('<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r9" Target="slides/slide9.xml"/><Relationship Id="remote" Target="https://example.com/private" TargetMode="External"/></Relationships>'),
    "ppt/slides/slide9.xml": strToU8('<p:sld><a:p><a:r><a:t>Actually first</a:t></a:r></a:p></p:sld>'),
    "ppt/slides/slide1.xml": strToU8('<p:sld><p:pic/></p:sld>'),
  });
  const result = await extractDocument(bytes, "pptx");
  expect(result.units[0]!.text).toBe("Actually first"); expect(result.units[1]!.text).toBe(""); expect(result.warnings.join(" ")).toContain("Слайд 2");
});
describe("untrusted or unreadable inputs", () => {
  it("refuses missing/password/binary office files", async () => {
    await expect(extractDocument(strToU8("not a zip"), "docx")).rejects.toBeInstanceOf(Error);
    await expect(extractDocument(zipSync({ "wrong.xml": strToU8("hello") }), "docx")).rejects.toBeInstanceOf(Error);
    await expect(extractDocument(new Uint8Array([0, 1, 2]), "txt")).rejects.toThrow("двійковий");
  });
  it("rejects an oversized decompressed XML before expansion", async () => {
    const bytes = zipSync({ "word/document.xml": strToU8("x".repeat(17 * 1024 * 1024)) });
    await expect(extractDocument(bytes, "docx")).rejects.toBeInstanceOf(Error);
  });
  it("does not silently drop large text or change foreign language/poetry line breaks", async () => {
    const text = "Grüße!\nHello!\nУкраїна.\n\n".repeat(2000);
    const result = await extractDocument(strToU8(text), "txt");
    expect(result.charCount).toBeGreaterThan(40000); expect(result.units.length).toBeGreaterThan(1);
    expect(result.units.map(unit => unit.text).join(" ")).toContain("Grüße!\nHello!");
  });
  it("accepts UTF-16 with BOM and fails invalid UTF-8 explicitly", async () => {
    const data = Buffer.from("\uFEFFУкраїнський текст", "utf16le");
    expect((await extractDocument(data, "txt")).units[0]!.text).toBe("Український текст");
    await expect(extractDocument(new Uint8Array([255, 255]), "txt")).rejects.toBeInstanceOf(Error);
  });
});
