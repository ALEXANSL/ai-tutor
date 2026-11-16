import { afterEach, expect, it, vi } from "vitest";
import { isDriveUploadUrl, openSourceUpload, putSourceUpload } from "./upload-source";
afterEach(() => vi.unstubAllGlobals());
it("only accepts HTTPS Google Drive upload sessions, never arbitrary upload destinations", () => {
  expect(isDriveUploadUrl("https://www.googleapis.com/upload/drive/v3/files?upload_id=123")).toBe(true);
  for (const value of ["https://evil.test/upload/drive/v3/files", "https://www.googleapis.com.evil.test/upload/drive/v3/files", "http://www.googleapis.com/upload/drive/v3/files", "https://www.googleapis.com/drive/v3/files", "javascript:alert(1)"]) expect(isDriveUploadUrl(value)).toBe(false);
});
it("opens a metadata-only session, never sends the selected file to the Vercel server", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ sessionUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=123" })); vi.stubGlobal("fetch", fetchMock);
  const file = new File(["source contents"], "book.docx", { type: "application/octet-stream" });
  await openSourceUpload(file); const init = fetchMock.mock.calls[0]![1] as RequestInit;
  expect(typeof init.body).toBe("string"); expect(JSON.parse(init.body as string)).toEqual({ fileName: "book.docx", mimeType: "application/octet-stream", size: file.size }); expect(init.body).not.toContain("source contents");
});
it("queries a completed resumable session on retry and reuses its file id without uploading the body again", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "AlreadyUploaded123" })); vi.stubGlobal("fetch", fetchMock);
  const result = await putSourceUpload(new File(["source contents"], "book.txt"), "https://www.googleapis.com/upload/drive/v3/files?upload_id=123", vi.fn(), true);
  expect(result).toBe("AlreadyUploaded123"); expect(fetchMock.mock.calls[0]![1]).toMatchObject({ headers: { "content-range": "bytes */15" } });
});
