import { expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { homeworkUploads } from "./uploads";
it("accepts bounded text and actual PDF pages and rejects forged image labels and oversized PDFs", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const result = await homeworkUploads([new File(["Поясни тему"], "завдання.txt"), new File([new Uint8Array(await pdf.save()) as BlobPart], "сторінка.pdf")]);
  expect(result.text).toContain("Поясни тему"); expect(result.documents[0]!.mediaType).toBe("application/pdf");
  await expect(homeworkUploads([new File(["<svg onload='x'/>"], "image.png", { type: "image/png" })])).rejects.toThrow("Підтримуються");
  for (let i = 0; i < 12; i++) pdf.addPage();
  await expect(homeworkUploads([new File([new Uint8Array(await pdf.save()) as BlobPart], "pages.pdf")])).rejects.toThrow("12 сторінок");
});
it("rejects oversized bundles before reading bytes", async () => {
  await expect(homeworkUploads([new File([new Uint8Array(3 * 1024 * 1024 + 1)], "large.txt")])).rejects.toThrow("3 МБ");
});
