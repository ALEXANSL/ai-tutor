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
it("prefers a same-origin upload relay and sends at most 1 MiB per request", async () => {
  const path = "/api/parent/books/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111";
  const file = new File([new Uint8Array(1443982)], "slides.pptx", { type: "application/octet-stream" });
  const f = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ uploadUrl: path })).mockResolvedValueOnce(Response.json({ offset: 1048576 })).mockResolvedValueOnce(Response.json({ offset: file.size, driveFileId: "UploadedDrive123" })); vi.stubGlobal("fetch", f);
  const session = await openSourceUpload(file); expect(session).toBe(path);
  expect(await putSourceUpload(file, session, vi.fn())).toBe("UploadedDrive123");
  const chunks = f.mock.calls.slice(1); expect(chunks).toHaveLength(2);
  expect(chunks[0]![1]).toMatchObject({ headers: { "content-range": `bytes 0-1048575/${file.size}` } });
  expect((chunks[0]![1]!.body as Blob).size).toBe(1048576); expect((chunks[1]![1]!.body as Blob).size).toBe(file.size - 1048576);
  expect(f.mock.calls.every(([url]) => String(url).startsWith("/api/parent/books/upload"))).toBe(true);
});
it("resumes a partial proxy upload from Google's acknowledged offset rather than reuploading the file", async () => {
  const path = "/api/parent/books/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111", file = new File([new Uint8Array(1500000)], "slides.pptx");
  const f = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ offset: 1048576 })).mockResolvedValueOnce(Response.json({ offset: file.size, driveFileId: "UploadedDrive123" })); vi.stubGlobal("fetch", f);
  expect(await putSourceUpload(file, path, vi.fn(), true)).toBe("UploadedDrive123");
  expect(f.mock.calls[0]![1]?.method).toBeUndefined();
  expect(f.mock.calls[1]![1]).toMatchObject({ method: "PUT", headers: { "content-range": "bytes 1048576-1499999/1500000" } });
});
it("recovers an already completed upload without sending bytes again", async () => {
  const f = vi.fn<typeof fetch>(async () => Response.json({ offset: 15, driveFileId: "AlreadyUploaded123" })); vi.stubGlobal("fetch", f);
  expect(await putSourceUpload(new File(["source contents"], "slides.txt"), "/api/parent/books/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111", vi.fn(), true)).toBe("AlreadyUploaded123"); expect(f).toHaveBeenCalledOnce(); expect(f.mock.calls[0]![1]?.body).toBeUndefined();
});
it("turns browser fetch failures into a typed recoverable error, never a raw English message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  await expect(openSourceUpload(new File(["pptx"], "slides.pptx"))).rejects.toMatchObject({ code: "network" });
});
it("rejects unexpected proxy destinations and non-advancing offsets", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ uploadUrl: "https://evil.test/api/parent/books/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111" })));
  await expect(openSourceUpload(new File(["pptx"], "slides.pptx"))).rejects.toThrow();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ offset: 0 })));
  await expect(putSourceUpload(new File(["pptx"], "slides.pptx"), "/api/parent/books/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111", vi.fn())).rejects.toMatchObject({ code: "network" });
});
