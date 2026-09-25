import { describe, expect, it } from "vitest";
import { AiNotConfiguredError, ProviderError } from "../ai/types";
import { DriveError } from "../drive/google";
import { buildTsQuery, cleanQuery, prefixStem } from "../search/query";
import { EpubError } from "./extract-epub";
import { errorCodeOf, IngestError, isRetryableIngestError } from "./pipeline";
import { planSync, type FolderFile, type KnownMaterial } from "./sync-plan";

const file = (id: string, over: Partial<FolderFile> = {}): FolderFile => ({
  id,
  name: `${id}.pdf`,
  mimeType: "application/pdf",
  md5Checksum: `md5-${id}`,
  modifiedTime: "2026-09-20T10:00:00.000Z",
  format: "pdf",
  ...over,
});
const known = (id: string, over: Partial<KnownMaterial> = {}): KnownMaterial => ({
  id: `m-${id}`,
  drive_file_id: id,
  name: `${id}.pdf`,
  drive_md5: `md5-${id}`,
  drive_modified_time: "2026-09-20T10:00:00+00:00",
  status: "ready",
  status_detail: null,
  ...over,
});

describe("planSync — 'Я додав — перевірити папку' (US-2.7 KP-4)", () => {
  it("queues new files, ignores unchanged ones", () => {
    const plan = planSync([known("a")], [file("a"), file("b")], { budgetBlocked: false });
    expect(plan.insert.map((i) => [i.file.id, i.status])).toEqual([["b", "queued"]]);
    expect(plan.requeue).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("re-indexes changed files and renames", () => {
    const plan = planSync([known("a")], [file("a", { md5Checksum: "new", name: "Нова назва.pdf" })], { budgetBlocked: false });
    expect(plan.requeue.map((r) => r.id)).toEqual(["m-a"]);
    expect(plan.rename).toEqual([{ id: "m-a", name: "Нова назва.pdf" }]);
  });

  it("uses modifiedTime when there is no md5 (e.g. Google-native uploads)", () => {
    const plan = planSync(
      [known("a", { drive_md5: null })],
      [file("a", { md5Checksum: undefined, modifiedTime: "2026-09-21T10:00:00Z" })],
      { budgetBlocked: false },
    );
    expect(plan.requeue).toHaveLength(1);
  });

  it("marks files deleted from the folder as removed (US-2.6 KP-6) and revives them", () => {
    expect(planSync([known("a"), known("b", { status: "removed" })], [], { budgetBlocked: false }).remove).toEqual(["m-a"]);
    const back = planSync([known("b", { status: "removed" })], [file("b")], { budgetBlocked: false });
    expect(back.requeue.map((r) => r.id)).toEqual(["m-b"]);
  });

  it("defers new books in budget mode and resumes them later (US-2.6 KP-5)", () => {
    const blocked = planSync([], [file("a")], { budgetBlocked: true });
    expect(blocked.insert[0]!.status).toBe("deferred");
    const resumed = planSync([known("a", { status: "deferred" })], [file("a")], { budgetBlocked: false });
    expect(resumed.requeue[0]!.status).toBe("queued");
    expect(planSync([known("a", { status: "deferred" })], [file("a")], { budgetBlocked: true }).requeue).toEqual([]);
  });

  it("retries only configuration errors automatically", () => {
    const cfg = planSync([known("a", { status: "error", status_detail: "ai_not_configured" })], [file("a")], { budgetBlocked: false });
    expect(cfg.requeue).toHaveLength(1);
    const broken = planSync([known("a", { status: "error", status_detail: "extract_failed" })], [file("a")], { budgetBlocked: false });
    expect(broken.requeue).toHaveLength(0);
  });
});

describe("ingest error mapping", () => {
  it("maps errors to parent-facing codes and retry decisions", () => {
    expect(errorCodeOf(new AiNotConfiguredError("x"))).toBe("ai_not_configured");
    expect(errorCodeOf(new DriveError("x", 404, "not_found"))).toBe("drive_file_missing");
    expect(errorCodeOf(new EpubError("x"))).toBe("extract_failed");
    expect(errorCodeOf(new IngestError("empty", "x"))).toBe("empty");
    expect(errorCodeOf(new Error("x"))).toBe("failed");
    expect(isRetryableIngestError(new ProviderError("x", "openai", 429, true))).toBe(true);
    expect(isRetryableIngestError(new ProviderError("x", "anthropic", 400, false))).toBe(false);
    expect(isRetryableIngestError(new DriveError("x", null, "network"))).toBe(true);
    expect(isRetryableIngestError(new DriveError("x", 413, "too_large"))).toBe(false);
    expect(isRetryableIngestError(new AiNotConfiguredError("x"))).toBe(false);
  });
});

describe("search query (ADR-008)", () => {
  it("turns words into safe prefix terms", () => {
    expect(buildTsQuery("дроби зі спільним знаменником")).toBe("дроб:* | спільн:* | знаменник:*");
    expect(buildTsQuery("Дроби!!! & | ! ( ) :*")).toBe("дроб:*");
    expect(buildTsQuery("і в на")).toBeNull();
    expect(buildTsQuery("")).toBeNull();
  });

  it("keeps short words whole and cleans the input", () => {
    expect(prefixStem("сума")).toBe("сума");
    expect(prefixStem("Відсотки")).toBe("відсот");
    expect(cleanQuery("  a \n  b ")).toBe("a b");
    expect(cleanQuery("x".repeat(500))).toHaveLength(200);
  });
});
