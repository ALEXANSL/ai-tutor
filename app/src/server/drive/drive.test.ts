import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseServiceAccount } from "../env";
import { buildServiceAccountAssertion, downloadFile, formatOf, isValidDriveId, listFolderFiles } from "./google";
import { checkFolderPublicAccess } from "./public-access";

const FOLDER = "FolderIdPlaceholder_0123456789";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("service account (ADR-003)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("parses the JSON key file and restores escaped newlines", () => {
    const sa = parseServiceAccount(
      JSON.stringify({ client_email: "reader@example.com", private_key: pem.replace(/\n/g, "\\n") }),
    );
    expect(sa?.clientEmail).toBe("reader@example.com");
    expect(sa?.privateKey).toBe(pem);
    expect(sa?.tokenUri).toBe("https://oauth2.googleapis.com/token");
    expect(parseServiceAccount("not json")).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: "x" }))).toBeNull();
  });

  it("signs a verifiable RS256 JWT with the read-only Drive scope", () => {
    const jwt = buildServiceAccountAssertion(
      { clientEmail: "reader@example.com", privateKey: pem, tokenUri: "https://oauth2.googleapis.com/token" },
      1_700_000_000,
    );
    const [h, c, s] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "reader@example.com",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("drive listing", () => {
  it("validates ids and formats", () => {
    expect(isValidDriveId(FOLDER)).toBe(true);
    expect(isValidDriveId("abc' or '1'='1")).toBe(false);
    expect(formatOf({ name: "a.EPUB", mimeType: "application/octet-stream" })).toBe("epub");
    expect(formatOf({ name: "a.docx", mimeType: "application/msword" })).toBeNull();
  });

  it("walks subfolders and pages, keeps PDF/EPUB only (US-2.1 KP-1)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams;
      if (q.get("q")!.includes(FOLDER) && !q.get("pageToken")) {
        return json({
          files: [
            { id: "SubFolderPlaceholder01", name: "Книги", mimeType: "application/vnd.google-apps.folder" },
            { id: "FilePdfPlaceholder001", name: "Математика.pdf", mimeType: "application/pdf", md5Checksum: "a" },
          ],
          nextPageToken: "p2",
        });
      }
      if (q.get("pageToken") === "p2") {
        return json({ files: [{ id: "FileDocPlaceholder001", name: "notes.docx", mimeType: "application/msword" }] });
      }
      return json({ files: [{ id: "FileEpubPlaceholder01", name: "Книга.epub", mimeType: "application/epub+zip" }] });
    });
    const res = await listFolderFiles(FOLDER, "token", fetchMock as never);
    expect(res.files.map((f) => [f.name, f.format])).toEqual([
      ["Математика.pdf", "pdf"],
      ["Книга.epub", "epub"],
    ]);
    expect(res.skipped).toBe(1);
    expect(fetchMock.mock.calls[0]![0]).toContain("trashed");
  });

  it("maps 404 to not_found and refuses oversized files", async () => {
    await expect(listFolderFiles(FOLDER, "t", (async () => new Response("", { status: 404 })) as never)).rejects.toMatchObject({
      code: "not_found",
    });
    const big = new Response("x", { status: 200, headers: { "content-length": String(500 * 1024 * 1024) } });
    await expect(downloadFile("FilePdfPlaceholder001", "t", (async () => big) as never)).rejects.toMatchObject({
      code: "too_large",
    });
  });
});

describe("folder public-access check (US-2.1 KP-2, R-8)", () => {
  const apiKey = "api-key-placeholder";

  it("is 'restricted' when the anonymous request gets 404", async () => {
    const res = await checkFolderPublicAccess({
      folderId: FOLDER,
      apiKey,
      fetchImpl: (async () => new Response("", { status: 404 })) as never,
    });
    expect(res).toEqual({ state: "restricted" });
  });

  it("reads the 'anyone' permission level through the service account", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/permissions")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sa-token");
        return json({ permissions: [{ type: "user", role: "owner" }, { type: "anyone", role: "writer" }] });
      }
      expect(url).toContain(`key=${apiKey}`);
      expect(init?.headers).toBeUndefined(); // anonymous
      return json({ id: FOLDER });
    });
    const res = await checkFolderPublicAccess({
      folderId: FOLDER,
      apiKey,
      getToken: async () => "sa-token",
      fetchImpl: fetchMock as never,
    });
    expect(res).toEqual({ state: "public", level: "writer" });
  });

  it("falls back to anonymous capabilities when permissions are not readable", async () => {
    const fetchMock = async (url: string) =>
      url.includes("/permissions")
        ? new Response("", { status: 403 })
        : json({ id: FOLDER, capabilities: { canEdit: false, canComment: false } });
    const res = await checkFolderPublicAccess({
      folderId: FOLDER,
      apiKey,
      getToken: async () => "t",
      fetchImpl: fetchMock as never,
    });
    expect(res).toEqual({ state: "public", level: "reader" });
  });

  it("reports a rejected key or missing config as unknown (no false alarm, no false 'safe')", async () => {
    expect(
      await checkFolderPublicAccess({ folderId: FOLDER, apiKey, fetchImpl: (async () => new Response("", { status: 400 })) as never }),
    ).toEqual({ state: "unknown", reason: "api_key_rejected" });
    expect(await checkFolderPublicAccess({ folderId: null, apiKey })).toEqual({ state: "unknown", reason: "not_configured" });
    expect(
      await checkFolderPublicAccess({
        folderId: FOLDER,
        apiKey,
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as never,
      }),
    ).toEqual({ state: "unknown", reason: "network" });
  });
});
