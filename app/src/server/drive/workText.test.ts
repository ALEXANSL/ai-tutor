import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveError } from "./google";

/**
 * S33 (PO decision 2026-09-30, 3rd/final correction): the complete text of
 * a literary work is written to (and read from) the family's own Google
 * Drive, never our Supabase DB. `getUserAccessToken` goes through Supabase
 * (a refresh-token RPC) — mocked the same way `upload.test.ts` mocks it, so
 * these tests exercise only the Drive HTTP calls this module makes.
 */
vi.mock("../supabase/clients", () => ({
  createServiceClient: () => ({ rpc: async () => ({ data: "refresh-token-123", error: null }) }),
}));

const { saveWorkFullTextToDrive, readWorkFullTextFromDrive, clearWorkTextReadCacheForTests } = await import("./workText");

const ORIGINAL = {
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  uploadsFolder: process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID,
};
beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID = "UploadsFolderPlaceholder01";
  clearWorkTextReadCacheForTests();
});
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

describe("saveWorkFullTextToDrive", () => {
  it("reports not_configured without calling fetch when the uploads folder isn't set", async () => {
    delete process.env.GOOGLE_DRIVE_UPLOADS_FOLDER_ID;
    const fetchImpl = vi.fn();
    await expect(saveWorkFullTextToDrive("fam1", "Тема 5.txt", "текст", fetchImpl as never)).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploads the text as a small multipart request to the family's uploads folder and returns the new file id", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      expect(url).toContain("uploadType=multipart");
      expect(String(init?.body)).toContain("Повний текст твору"); // the text body is actually sent
      expect(String(init?.body)).toContain("UploadsFolderPlaceholder01"); // parents: [folderId]
      return new Response(JSON.stringify({ id: "new-file-id" }), { status: 200 });
    });
    const id = await saveWorkFullTextToDrive("fam1", "Тема 5.txt", "Повний текст твору тут.", fetchImpl as never);
    expect(id).toBe("new-file-id");
  });

  it("throws a DriveError on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    await expect(saveWorkFullTextToDrive("fam1", "x.txt", "y", fetchImpl as never)).rejects.toBeInstanceOf(DriveError);
  });
});

const FILE_ID_1 = "file-1234567890";
const FILE_ID_2 = "file-2234567890";
const FILE_ID_3 = "file-3234567890";

function oauthAnd(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    return fetchImpl(url, init);
  });
}

describe("readWorkFullTextFromDrive", () => {
  it("downloads the file content with alt=media", async () => {
    const fetchImpl = oauthAnd(async (url) => {
      expect(url).toContain(`/files/${FILE_ID_1}`);
      expect(url).toContain("alt=media");
      return new Response("Повний текст.", { status: 200 });
    });
    const text = await readWorkFullTextFromDrive("fam1", FILE_ID_1, fetchImpl as never);
    expect(text).toBe("Повний текст.");
  });

  it("caches the result for repeat reads within the TTL — only one Drive call", async () => {
    const fetchImpl = oauthAnd(async () => new Response("cached text", { status: 200 }));
    const first = await readWorkFullTextFromDrive("fam1", FILE_ID_2, fetchImpl as never);
    const second = await readWorkFullTextFromDrive("fam1", FILE_ID_2, fetchImpl as never);
    expect(first).toBe("cached text");
    expect(second).toBe("cached text");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // token exchange only on the first, real download
  });

  it("rejects an invalid drive file id without calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(readWorkFullTextFromDrive("fam1", "!!!", fetchImpl as never)).rejects.toMatchObject({ code: "not_found" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a DriveError with code not_found on a 404", async () => {
    const fetchImpl = oauthAnd(async () => new Response("gone", { status: 404 }));
    await expect(readWorkFullTextFromDrive("fam1", FILE_ID_3, fetchImpl as never)).rejects.toMatchObject({ code: "not_found" });
  });
});
