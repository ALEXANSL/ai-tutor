import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveError } from "./google";
import { confirmUpload, initResumableUpload, MAX_UPLOAD_BYTES, sanitizeFileName } from "./upload";

// `getUserAccessToken` reads the family's refresh token through
// `createServiceClient().rpc(...)` (Supabase) — mocked here so these tests
// exercise only the Drive HTTP calls this module is responsible for,
// without needing a real Supabase connection.
vi.mock("../supabase/clients", () => ({
  createServiceClient: () => ({
    rpc: async () => ({ data: "refresh-token-123", error: null }),
  }),
}));
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
 * BUG-033: the fix for the 413/platform-body-limit bug is that no file bytes
 * ever pass through `initResumableUpload` — it is a metadata-only POST to
 * Drive's resumable-session endpoint. These tests assert exactly that: the
 * options object never carries a body/stream, and validation rejects a bad
 * request before any Drive call happens at all.
 */
describe("initResumableUpload — validation before any Drive call", () => {
  it("rejects an unsupported file type without ever calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      initResumableUpload({
        familyId: "f1",
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
      initResumableUpload({
        familyId: "f1",
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
      initResumableUpload({
        familyId: "f1",
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
      initResumableUpload({
        familyId: "f1",
        fileName: "book.pdf",
        mimeType: "application/pdf",
        declaredSize: 100,
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("returns the Drive-provided session URI from the Location header, sending only JSON metadata (no file bytes)", async () => {
    process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID = "UploadsFolderPlaceholder01";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      void init;
      return new Response(null, { status: 200, headers: { location: "https://googleapis.com/upload/session/abc" } });
    });
    const session = await initResumableUpload({
      familyId: "f1",
      fileName: "book.pdf",
      mimeType: "application/pdf",
      declaredSize: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(session.sessionUrl).toBe("https://googleapis.com/upload/session/abc");
    // The Drive-session-open call must carry only JSON metadata, never a stream/binary body.
    const driveCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("/upload/drive/v3/files"));
    expect(driveCall).toBeDefined();
    const [, init] = driveCall as [string, RequestInit];
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "book.pdf", parents: ["UploadsFolderPlaceholder01"] });
  });
});

describe("confirmUpload — re-fetches metadata from Drive, never trusts the client", () => {
  function fetchImplFor(fileMeta: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify(fileMeta), { status: 200 });
    });
  }

  it("rejects a file that is not in the family's uploads folder (confused-deputy guard)", async () => {
    process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID = "UploadsFolderPlaceholder01";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    const fetchImpl = fetchImplFor({
      id: "UploadedFile0001234",
      name: "book.pdf",
      mimeType: "application/pdf",
      parents: ["SomeOtherFolder"],
    });
    await expect(
      confirmUpload({ familyId: "f1", driveFileId: "UploadedFile0001234", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects an unsupported file type reported by Drive", async () => {
    process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID = "UploadsFolderPlaceholder01";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    const fetchImpl = fetchImplFor({
      id: "UploadedFile0001234",
      name: "notes.docx",
      mimeType: "application/msword",
      parents: ["UploadsFolderPlaceholder01"],
    });
    await expect(
      confirmUpload({ familyId: "f1", driveFileId: "UploadedFile0001234", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "unsupported_type" });
  });

  it("rejects a file whose real (Drive-reported) size is over the product limit, even though the platform allows more", async () => {
    process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID = "UploadsFolderPlaceholder01";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    const fetchImpl = fetchImplFor({
      id: "UploadedFile0001234",
      name: "book.pdf",
      mimeType: "application/pdf",
      parents: ["UploadsFolderPlaceholder01"],
      size: String(MAX_UPLOAD_BYTES + 1),
    });
    await expect(
      confirmUpload({ familyId: "f1", driveFileId: "UploadedFile0001234", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("returns the uploaded file's metadata once it passes every check", async () => {
    process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID = "UploadsFolderPlaceholder01";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
    const fetchImpl = fetchImplFor({
      id: "UploadedFile0001234",
      name: "book.pdf",
      mimeType: "application/pdf",
      parents: ["UploadsFolderPlaceholder01"],
      size: "1234",
      modifiedTime: "2026-09-27T00:00:00Z",
      md5Checksum: "abc",
    });
    const file = await confirmUpload({ familyId: "f1", driveFileId: "UploadedFile0001234", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(file).toMatchObject({ id: "UploadedFile0001234", name: "book.pdf", format: "pdf", size: 1234 });
  });
});

describe("DriveError.code accepts 'unsupported_type'", () => {
  it("round-trips through the error class", () => {
    const e = new DriveError("nope", null, "unsupported_type");
    expect(e.code).toBe("unsupported_type");
  });
});
