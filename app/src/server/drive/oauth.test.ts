import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl, ensureAppFolder, grantServiceAccountReader, isOAuthClientConfigured } from "./oauth";

const ORIGINAL = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
};
afterEach(() => {
  if (ORIGINAL.id === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  else process.env.GOOGLE_OAUTH_CLIENT_ID = ORIGINAL.id;
  if (ORIGINAL.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  else process.env.GOOGLE_OAUTH_CLIENT_SECRET = ORIGINAL.secret;
});

describe("isOAuthClientConfigured / buildAuthorizeUrl", () => {
  it("is not configured, and returns no URL, when the client id/secret are missing", () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    expect(isOAuthClientConfigured()).toBe(false);
    expect(buildAuthorizeUrl("https://app.example/cb", "state123")).toBeNull();
  });

  it("builds a consent URL that forces `prompt=consent` (so a reconnect still yields a refresh token) and carries the drive.file scope only", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id-123";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret-123";
    expect(isOAuthClientConfigured()).toBe(true);
    const url = buildAuthorizeUrl("https://app.example/api/google/drive/callback", "state123");
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("client_id")).toBe("client-id-123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example/api/google/drive/callback");
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("state")).toBe("state123");
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("ensureAppFolder — idempotent create-or-reuse (ADR-024 §2)", () => {
  it("reuses an existing same-named folder instead of creating a duplicate", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(decodeURIComponent(url)).toContain("ШІ-Репетитор");
      return json({ files: [{ id: "ExistingFolderId0123456789" }] });
    });
    const id = await ensureAppFolder("ШІ-Репетитор — Мої книги", "token", fetchMock as never);
    expect(id).toBe("ExistingFolderId0123456789");
    expect(fetchMock).toHaveBeenCalledTimes(1); // never reaches the create call
  });

  it("creates a new folder when none exists yet", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json({ files: [] }); // lookup
      return json({ id: "NewFolderId0123456789012" });
    });
    const id = await ensureAppFolder("ШІ-Репетитор — Мої книги", "token", fetchMock as never);
    expect(id).toBe("NewFolderId0123456789012");
  });
});

describe("grantServiceAccountReader — idempotent share (ADR-024 §3)", () => {
  it("skips the permissions.create call when the service account already has reader/writer access", async () => {
    const fetchMock = vi.fn(async () =>
      json({ permissions: [{ emailAddress: "ai-tutor-drive-reader@example.com", role: "reader" }] }),
    );
    await grantServiceAccountReader("Folder1", "token", "ai-tutor-drive-reader@example.com", fetchMock as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("grants reader access when the service account has no permission yet", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return json({ permissions: [] });
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ role: "reader", type: "user", emailAddress: "sa@example.com" });
      return json({ id: "perm1" });
    });
    await grantServiceAccountReader("Folder1", "token", "sa@example.com", fetchMock as never);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
