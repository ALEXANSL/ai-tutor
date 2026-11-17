import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const f = vi.hoisted(() => ({ access: vi.fn(), relay: vi.fn(), read: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.access }));
vi.mock("@/server/drive/upload-relay", async original => ({ ...await original<typeof import("@/server/drive/upload-relay")>(), relaySourceUpload: f.relay, readUploadChunk: f.read }));
import { GET, PUT } from "./route";
import { UploadRelayError } from "@/server/drive/upload-relay";
const url = "https://fixture.test/api/parent/books/upload/chunk?uploadId=11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); f.access.mockResolvedValue({ familyId: "family" }); f.relay.mockResolvedValue({ offset: 4, driveFileId: "DriveFileId123" }); f.read.mockResolvedValue(new Uint8Array(4)); });
it("requires parent access before reading or forwarding file bytes", async () => {
  f.access.mockRejectedValue(new Error("denied")); await expect(PUT(new NextRequest(url, { method: "PUT", body: new Blob(["data"]) }))).rejects.toThrow("denied"); expect(f.read).not.toHaveBeenCalled(); expect(f.relay).not.toHaveBeenCalled();
});
it("passes only the authenticated family, opaque session id and actual chunk to the relay", async () => {
  const response = await PUT(new NextRequest(url, { method: "PUT", headers: { "content-range": "bytes 0-3/4" }, body: new Blob(["data"]) })); expect(response.status).toBe(200); expect(f.relay).toHaveBeenCalledWith("family", "11111111-1111-4111-8111-111111111111", { bytes: new Uint8Array(4), range: "bytes 0-3/4" }); expect(response.headers.get("cache-control")).toBe("no-store");
});
it("checks status with no file bytes and returns structured retryable failures", async () => {
  await GET(new NextRequest(url)); expect(f.read).not.toHaveBeenCalled(); expect(f.relay).toHaveBeenCalledWith("family", "11111111-1111-4111-8111-111111111111", undefined);
  f.relay.mockRejectedValue(new UploadRelayError("network", 502)); const response = await GET(new NextRequest(url)); expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "network" });
});
