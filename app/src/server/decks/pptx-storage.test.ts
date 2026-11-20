import { expect, it, vi } from "vitest";
import { deckRetry } from "./retry";
import { PPTX_BUCKET, PPTX_MIME, powerpointDestination, storageFailure } from "./pptx-storage";

const storage = vi.hoisted(() => ({ getBucket: vi.fn(), createBucket: vi.fn(), from: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage }) }));

it("creates a private destination accepting PowerPoint on the first upload", async () => {
  storage.getBucket.mockResolvedValueOnce({ error: { message: "Bucket not found" } }).mockResolvedValueOnce({ data: { public: false } });
  storage.createBucket.mockResolvedValueOnce({ error: null });
  await powerpointDestination();
  expect(storage.createBucket).toHaveBeenCalledWith(PPTX_BUCKET, expect.objectContaining({ public: false, allowedMimeTypes: [PPTX_MIME] }));
  expect(storage.from).toHaveBeenCalledWith(PPTX_BUCKET);
});

it("does not schedule an endless network retry for a rejected file type", () => {
  const error = storageFailure("Збереження PowerPoint", { message: "mime type not supported", statusCode: "400" });
  expect(deckRetry(error, 4)).toBeNull();
  expect(deckRetry(storageFailure("Збереження PowerPoint", { message: "Unavailable", statusCode: 503 }), 4)).not.toBeNull();
});
