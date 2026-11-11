import { expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractAudioPdf, pdfAudioLines } from "./pdf-source";
it("extracts only selected real PDF pages with retained boundaries", async () => {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) { const page = pdf.addPage(); page.drawText(`Page ${n}: The ship approached a quiet island.`, { x: 40, y: 700, size: 12, font }); page.drawText(`Figure ${n}. A sailing ship`, { x: 40, y: 580, size: 10, font }); page.drawText(String(n), { x: 300, y: 40, size: 10, font }); }
  const result = await extractAudioPdf(await pdf.save(), { from: 2, to: 2 });
  expect(result.pageCount).toBe(3); expect(result.units).toHaveLength(1); expect(result.units[0]!.page).toBe(2); expect(result.units[0]!.text).toContain("Page 2"); expect(result.units[0]!.text).not.toContain("Page 1"); expect(result.units[0]!.text).toContain("\n\n");
});
it("does not insert spaces between kerned fragments of the same word", () => {
  expect(pdfAudioLines([{ str: "Ро", width: 10, transform: [1,0,0,1,10,100] }, { str: "бінзон", width: 30, transform: [1,0,0,1,20,100] }, { str: "Крузо", width: 25, transform: [1,0,0,1,55,100] }])).toBe("Робінзон Крузо");
});
