import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveError } from "./google";
import { boundedUploadStream, MAX_UPLOAD_BYTES, sanitizeFileName, uploadBookFromBrowser } from "./upload";

const ORIGINAL = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  uploadsFolder: process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID,
};
afterEach(() => {
  for (const [k, v] of Object.entries({
    GOOGLE_OAUTH_CLIENT_ID: ORIGINAL.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: ORIGINAL.clientSecret,
    GOOGLE_DRIVE_UPLOADS_FOLDER_ID: ORIGINAL.uploadsFolder,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("sanitizeFileName", () => {
  it("strips path separators and trims length", () => {
    expect(sanitizeFileName("../../etc/Підручник.pdf")).toBe(".._.._etc_Підручник.pdf");
    expect(sanitizeFileName("a\\b.pdf")).toBe("a_b.pdf");
    expect(sanitizeFileName("  ")).toBe("book");
    expect(sanitizeFileName("x".repeat(500)).length).toBe(200);
  });
});

/**
 * BUG-003, mirrored for the opposite direction (browser → server → Drive):
 * the request body must never be buffered whole before the size check.
 */
describe("boundedUploadStream — aborts a streamed upload once MAX_UPLOAD_BYTES is exceeded, without buffering the whole file", () => {
  it("passes small chunks through untouched", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    let i = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]!);
        else controller.close();
      },
    });
    const { stream, tooLarge } = boundedUploadStream(input, MAX_UPLOAD_BYTES);
    const reader = stream.getReader();
    const out: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    expect(out).toEqual(chunks);
    expect(tooLarge()).toBe(false);
  });

  it("errors the stream and cancels the reader as soon as the byte count crosses the limit", async () => {
    const chunkSize = 10 * 1024 * 1024; // "10 MB" chunks — only byteLength is real, no data allocated.
    let reads = 0;
    let cancelled = false;
    const input = {
      getReader: () => ({
        read: vi.fn(async () => {
          reads += 1;
          return { done: false, value: { byteLength: chunkSize } };
        }),
        cancel: vi.fn(async () => {
          cancelled = true;
        }),
      }),
    } as unknown as ReadableStream<Uint8Array>;

    const { stream, tooLarge } = boundedUploadStream(input, MAX_UPLOAD_BYTES);
    const reader = stream.getReader();
    await expect(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }).rejects.toThrow();
    expect(tooLarge()).toBe(true);
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(Math.ceil(MAX_UPLOAD_BYTES / chunkSize) + 1);
  });
});

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

describe("uploadBookFromBrowser — validation before any Drive call", () => {
  it("rejects an unsupported file type without ever calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      uploadBookFromBrowser({
        familyId: "f1",
        body: emptyBody(),
        fileName: "notes.docx",
        mimeType: "application/msword",
        declaredSize: 100,
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toMatchObject({ code: "unsupported_type" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a declared size over the limit without calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      uploadBookFromBrowser({
        familyId: "f1",
        body: emptyBody(),
        fileName: "book.pdf",
        mimeType: "application/pdf",
        declaredSize: MAX_UPLOAD_BYTES + 1,
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 'not_configured' when the uploads folder id is not set", async () => {
    delete process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID;
    const fetchImpl = vi.fn();
    await expect(
      uploadBookFromBrowser({
        familyId: "f1",
        body: emptyBody(),
        fileName: "book.pdf",
        mimeType: "application/pdf",
        declaredSize: 100,
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 'not_configured' when Drive is configured but Google Drive was never connected (no refresh token)", async () => {
    process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID = "UploadsFolderPlaceholder01";
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const fetchImpl = vi.fn();
    await expect(
      uploadBookFromBrowser({
        familyId: "f1",
        body: emptyBody(),
        fileName: "book.pdf",
        mimeType: "application/pdf",
        declaredSize: 100,
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("DriveError.code accepts 'unsupported_type'", () => {
  it("round-trips through the error class", () => {
    const e = new DriveError("nope", null, "unsupported_type");
    expect(e.code).toBe("unsupported_type");
  });
});
