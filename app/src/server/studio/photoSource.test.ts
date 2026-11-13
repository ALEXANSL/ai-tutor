import { beforeEach, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
const f = vi.hoisted(() => ({ call: vi.fn(), route: vi.fn() }));
vi.mock("@/server/ai/router", () => ({ callVisionStructured: f.call, defaultRouterDeps: { loadRoute: f.route } }));
import { recognizeStudioPage } from "./photoSource";
beforeEach(() => { vi.clearAllMocks(); f.call.mockResolvedValue({ result: { text: "Exercise 3. Write the sentences. Wie heißt du?", unreadable: false, tasks: [{ label: "3", text: "Write the sentences." }], warnings: [] } }); });
it("recognizes original-language text and numbered exercises through the existing budgeted OCR route", async () => {
  const photo = new File([new Uint8Array([255, 216, 255, 0])], "private-name.jpg", { type: "image/jpeg" });
  const result = await recognizeStudioPage("family", photo); expect(result.text).toContain("Wie heißt du?"); expect(result.tasks[0]!.label).toBe("3");
  const [role, request, context] = f.call.mock.calls[0]!; expect(role).toBe("ocr_page"); expect(context).toEqual({ familyId: "family" }); expect(request.documents[0].mediaType).toBe("image/jpeg"); expect(JSON.stringify(request)).not.toContain("private-name");
});
it("rejects spoofed media, oversized files and PDFs above three pages before paid work", async () => {
  await expect(recognizeStudioPage("family", new File(["not an image"], "fake.jpg", { type: "image/jpeg" }))).rejects.toThrow("Підтримуються");
  await expect(recognizeStudioPage("family", new File([new Uint8Array(3 * 1024 * 1024 + 1)], "large.png"))).rejects.toThrow("до 3 МБ");
  const pdf = await PDFDocument.create(); for (let i = 0; i < 4; i++) pdf.addPage();
  await expect(recognizeStudioPage("family", new File([new Uint8Array(await pdf.save())], "scan.pdf"))).rejects.toThrow("трьох сторінок"); expect(f.call).not.toHaveBeenCalled();
});
it("does not turn unreadable pictures into invented lesson source or retry automatically", async () => {
  f.call.mockResolvedValue({ result: { text: "", unreadable: true, tasks: [], warnings: [] } });
  await expect(recognizeStudioPage("family", new File([new Uint8Array([255, 216, 255])], "photo.jpg"))).rejects.toThrow("чіткіше фото"); expect(f.call).toHaveBeenCalledTimes(1);
});
it("bounds the configured OCR route without replacing the owner's provider", async () => {
  f.route.mockResolvedValue({ primary_provider: "openai", primary_model: "configured", params: { max_tokens: 20000, timeout_ms: 600000 } });
  await recognizeStudioPage("family", new File([new Uint8Array([255, 216, 255])], "page.jpg"));
  const route = await f.call.mock.calls[0]![3].loadRoute("family", "ocr_page");
  expect(route.primary_model).toBe("configured"); expect(route.params).toMatchObject({ max_tokens: 5000, timeout_ms: 90000 });
});
