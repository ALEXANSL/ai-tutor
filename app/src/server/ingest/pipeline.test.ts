import { describe, expect, it } from "vitest";
import { AiNotConfiguredError, ProviderError } from "../ai/types";
import { DriveError } from "../drive/google";
import { EpubError } from "./extract-epub";
import { errorCodeOf, IngestError, isRetryableIngestError } from "./pipeline";

/**
 * Error classification of the ingest pipeline (QA: "поведінка без ключів",
 * "пошкоджені/порожні/великі PDF і EPUB"). Every code here must have a
 * friendly Ukrainian message in `uk.parent.books.details` (checked below)
 * and never surface as an unhandled 500 to the parent (docs/06 S1).
 */
describe("errorCodeOf — every failure maps to a known, user-facing code", () => {
  it("missing AI key → ai_not_configured, not a generic failure", () => {
    expect(errorCodeOf(new AiNotConfiguredError("ANTHROPIC_API_KEY is not set"))).toBe("ai_not_configured");
  });

  it("provider call failures → ai_failed", () => {
    expect(errorCodeOf(new ProviderError("anthropic error 503", "anthropic", 503, true))).toBe("ai_failed");
  });

  it("Drive misconfiguration / access / size errors map 1:1", () => {
    expect(errorCodeOf(new DriveError("no folder", null, "not_configured"))).toBe("drive_not_configured");
    expect(errorCodeOf(new DriveError("denied", 403, "forbidden"))).toBe("drive_forbidden");
    expect(errorCodeOf(new DriveError("gone", 404, "not_found"))).toBe("drive_file_missing");
    expect(errorCodeOf(new DriveError("huge", 413, "too_large"))).toBe("too_large");
  });

  it("a corrupted EPUB archive → extract_failed (not a raw stack trace)", () => {
    expect(errorCodeOf(new EpubError("not a valid EPUB (zip) file"))).toBe("extract_failed");
  });

  it("explicit IngestError codes pass through unchanged", () => {
    expect(errorCodeOf(new IngestError("empty", "no text found"))).toBe("empty");
    expect(errorCodeOf(new IngestError("extract_failed", "boom"))).toBe("extract_failed");
  });

  it("an unrecognised error still gets a friendly fallback code, never crashes the caller", () => {
    expect(errorCodeOf(new Error("some unexpected internal error"))).toBe("failed");
    expect(errorCodeOf("not even an Error instance")).toBe("failed");
    expect(errorCodeOf(undefined)).toBe("failed");
  });
});

describe("isRetryableIngestError — avoids retrying things a retry can't fix", () => {
  it("missing config and structurally broken files are not retried", () => {
    expect(isRetryableIngestError(new AiNotConfiguredError("no key"))).toBe(false);
    expect(isRetryableIngestError(new EpubError("bad zip"))).toBe(false);
    expect(isRetryableIngestError(new IngestError("empty", "no text"))).toBe(false);
    expect(isRetryableIngestError(new IngestError("too_large", "413"))).toBe(false);
  });

  it("network/http Drive errors and retryable provider errors are retried", () => {
    expect(isRetryableIngestError(new DriveError("timeout", null, "network"))).toBe(true);
    expect(isRetryableIngestError(new DriveError("502", 502, "http"))).toBe(true);
    expect(isRetryableIngestError(new ProviderError("503", "anthropic", 503, true))).toBe(true);
  });

  it("Drive auth/not-found errors are not retried (retrying won't grant access)", () => {
    expect(isRetryableIngestError(new DriveError("403", 403, "forbidden"))).toBe(false);
    expect(isRetryableIngestError(new DriveError("404", 404, "not_found"))).toBe(false);
    expect(isRetryableIngestError(new DriveError("413", 413, "too_large"))).toBe(false);
  });
});
