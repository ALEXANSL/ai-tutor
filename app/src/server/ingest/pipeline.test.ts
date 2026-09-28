import { describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError, ProviderError } from "../ai/types";
import { DriveError } from "../drive/google";
import { EpubError } from "./extract-epub";

/**
 * Mocks for the checkpoint tests below (`describe("cost-safety checkpoint …")`):
 * `runStructureSection`/`runStructureOutline` are exercised end-to-end with a
 * tiny in-memory fake in place of Supabase, so a downstream DB/RPC failure
 * can be simulated deterministically. Every other test in this file only
 * imports pure functions and never touches these mocks.
 */
const callStructured = vi.fn();
vi.mock("../ai/router", () => ({ callStructured: (...args: unknown[]) => callStructured(...args) }));

const getBudget = vi.fn(async (..._args: unknown[]) => ({ state: "ok" }) as never);
vi.mock("../ai/store", () => ({
  getBudget: (...args: unknown[]) => getBudget(...args),
  loadPrice: vi.fn(),
  loadRoute: vi.fn(),
}));

let fakeScope: unknown;
vi.mock("../db/family-scope", () => ({ forFamily: () => fakeScope }));

const enqueueJob = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../jobs/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jobs/runner")>();
  return { ...actual, enqueueJob: (...args: unknown[]) => enqueueJob(...args) };
});

vi.mock("../lessons/warmup", () => ({ warmAheadForSubject: vi.fn(async () => {}) }));

const { errorCodeOf, IngestError, isRetryableIngestError, runStructureOutline, runStructureSection, skipReextraction } = await import("./pipeline");

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

/**
 * QA regression: re-indexing the same unchanged file must not run OCR (or
 * any other extraction step) a second time. This is `runExtract`'s guard —
 * exercised directly here since a full run requires Drive/AI/job-runner
 * mocking that a pure decision function does not.
 */
describe("skipReextraction — re-indexing the same file never re-runs OCR/extraction", () => {
  it("skips straight to embed (no OCR requeue) when the hash is unchanged and the chunks are still there", () => {
    expect(skipReextraction("same-hash", "same-hash", 12)).toBe(true);
  });

  it("re-extracts (so OCR can run) when the file actually changed", () => {
    expect(skipReextraction("new-hash", "old-hash", 12)).toBe(false);
  });

  it("re-extracts when the hash matches but the chunks were wiped (index never actually completed)", () => {
    expect(skipReextraction("same-hash", "same-hash", 0)).toBe(false);
  });

  it("re-extracts on the very first index (no previous hash yet)", () => {
    expect(skipReextraction("first-hash", null, 0)).toBe(false);
  });
});

/**
 * A minimal in-memory stand-in for `forFamily(...)`'s Supabase-backed
 * `FamilyScope` — just enough of the chainable `.eq().order().returns()`
 * shape for the two code paths under test below, plus `scope.client` for
 * the `.insert().select().single()` and `.rpc()` calls `runStructureOutline`/
 * `runStructureSection` make directly. It ignores filters and always
 * resolves a table's current in-memory row(s), which is enough since every
 * test here has at most one row per table.
 */
function makeChain(single: unknown, list: unknown) {
  const chain: Record<string, unknown> = {
    eq: () => chain,
    or: () => chain,
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: () => chain,
    returns: () => chain,
    select: () => chain,
    maybeSingle: async () => single,
    single: async () => single,
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(list).then(resolve, reject),
  };
  return chain;
}

interface FakeState {
  material: Record<string, unknown>;
  section: Record<string, unknown>;
  oldSections: { id: string; title: string; manual_override: boolean }[];
  /** Number of times each RPC has been called so far — lets a test fail an RPC on its first call and succeed after. */
  rpcCalls: Record<string, number>;
  /** RPC name -> attempt number (1-based) -> `{ error }` to return; the last configured attempt repeats for any further call. */
  rpcResults: Record<string, { error: unknown }[]>;
}

function makeFakeScope(state: FakeState) {
  return {
    select(table: string) {
      if (table === "materials") return makeChain({ data: state.material, error: null }, { data: [state.material], error: null });
      if (table === "material_sections") {
        // Serves both the single-section fetch (`.maybeSingle()`) and
        // `finalizeMaterialStatus`'s whole-list fetch (plain `.returns()`
        // await) — and, for `runStructureOutline`'s `oldSections` query,
        // the same underlying array.
        return makeChain({ data: state.section, error: null }, { data: state.oldSections.length ? state.oldSections : [state.section], error: null });
      }
      // chunks / topics / subjects / academic_years: no test data needed —
      // an empty/null result is enough since these tests pick a non-"textbook"
      // `strategy` (see the fixtures below), so nothing downstream reads them.
      return makeChain({ data: null, error: null }, { data: [], error: null });
    },
    update(table: string, values: Record<string, unknown>) {
      if (table === "materials") Object.assign(state.material, values);
      if (table === "material_sections") Object.assign(state.section, values);
      return makeChain({ error: null }, { error: null });
    },
    delete() {
      return makeChain({ error: null }, { error: null });
    },
    insert() {
      return makeChain({ error: null }, { error: null });
    },
    upsert() {
      return makeChain({ error: null }, { error: null });
    },
    client: {
      from(_table: string) {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const id = `sec-${state.oldSections.length + 1}`;
                state.oldSections.push({ id, title: row.title as string, manual_override: false });
                return { data: { id }, error: null };
              },
            }),
          }),
        };
      },
      async rpc(name: string) {
        const n = (state.rpcCalls[name] = (state.rpcCalls[name] ?? 0) + 1);
        const results = state.rpcResults[name];
        if (!results) return { error: null };
        return results[Math.min(n, results.length) - 1]!;
      },
    },
  };
}

/**
 * Post-incident cost-safety fix (2026-09-28): `runStructureSection`/
 * `runStructureOutline` each make ONE paid AI call and then do several more
 * deterministic, retryable DB writes. Before the fix, ANY of those writes
 * failing re-ran the whole job — including a SECOND paid call for the same
 * section/book, even though the first one already succeeded. These tests
 * simulate exactly that: the AI call succeeds, a downstream DB/RPC step then
 * throws, and a retry (a second direct call to the same function, standing
 * in for the job runner re-invoking it) must reuse the cached answer instead
 * of paying for the model again.
 */
describe("cost-safety checkpoint — a downstream DB failure after a successful AI call never re-bills it", () => {
  it("runStructureSection: AI called once even though assign_chunk_structure fails on the first attempt", async () => {
    callStructured.mockClear();
    callStructured.mockResolvedValue({ result: { topics: [], dependencies: [], related_topics: [], problems: [] }, model: { provider: "anthropic", model: "m" }, costUsd: 0.01 });

    const state: FakeState = {
      material: {
        id: "mat-1",
        name: "book.pdf",
        title: null,
        status: "indexing",
        kind: "worksheet", // not a registered "textbook" kind → structureStrategy defaults to "contents"
        kind_manual: false,
        subject_id: null,
        subject_manual: false,
        topics_manual: true, // skips material_topic_links (untested here, irrelevant to this fix)
        page_count: 10,
        grade: null,
        curriculum_version: null,
        structure_outline_result: null,
      },
      section: { id: "sec-1", title: "Розділ 1", page_from: 1, page_to: 5, sort_order: 0, status: "indexing", status_detail: null, structure_result: null },
      oldSections: [],
      rpcCalls: {},
      rpcResults: {
        // Fails the DOWNSTREAM (deterministic) step on the very first call,
        // after the AI call above has already succeeded — this is the
        // confirmed mechanism from the real incident. Succeeds on retry.
        assign_chunk_structure: [{ error: { message: "transient db error" } }, { error: null }],
      },
    };
    fakeScope = makeFakeScope(state);

    const job = { id: "job-1", family_id: "fam-1", type: "ingest.structure_section", payload: { materialId: "mat-1", sectionId: "sec-1" }, attempts: 1, max_attempts: 5 };

    await expect(runStructureSection(job)).rejects.toThrow(/assign_chunk_structure failed/);
    expect(callStructured).toHaveBeenCalledTimes(1);
    // The checkpoint was written before the downstream failure.
    expect(state.section.structure_result).not.toBeNull();
    expect(state.section.status).toBe("indexing"); // never reached "ready" on this attempt

    // Retry: the job runner would re-invoke the same handler on the same job.
    await runStructureSection(job);
    expect(callStructured).toHaveBeenCalledTimes(1); // still just once — no second paid call
    expect(state.section.status).toBe("ready");
    expect(state.section.structure_result).toBeNull(); // cleared once genuinely done
  });

  it("runStructureOutline: AI called once even though the section fan-out (enqueueJob) fails on the first attempt", async () => {
    callStructured.mockClear();
    enqueueJob.mockClear();
    callStructured.mockResolvedValue({
      result: { title: "Підручник", kind: "worksheet", subject_code: "none", grade: null, sections: [{ title: "Розділ 1", page_from: 1, page_to: 5 }] },
      model: { provider: "anthropic", model: "m" },
      costUsd: 0.01,
    });
    enqueueJob.mockRejectedValueOnce(new Error("transient enqueue failure")).mockResolvedValue(undefined);

    const state: FakeState = {
      material: {
        id: "mat-2",
        name: "book.pdf",
        title: "Книга",
        status: "indexing",
        kind: "worksheet",
        kind_manual: false,
        subject_id: null,
        subject_manual: false,
        topics_manual: true,
        page_count: 10,
        grade: null,
        curriculum_version: null,
        structure_outline_result: null,
      },
      section: { id: "unused", title: "unused", page_from: null, page_to: null, sort_order: 0, status: "pending", status_detail: null, structure_result: null },
      oldSections: [],
      rpcCalls: {},
      rpcResults: {},
    };
    fakeScope = makeFakeScope(state);

    const job = { id: "job-2", family_id: "fam-1", type: "ingest.structure_outline", payload: { materialId: "mat-2" }, attempts: 1, max_attempts: 5 };

    await expect(runStructureOutline(job)).rejects.toThrow(/transient enqueue failure/);
    expect(callStructured).toHaveBeenCalledTimes(1);
    expect(state.material.structure_outline_result).not.toBeNull(); // checkpoint written before the fan-out failure

    // Retry.
    await runStructureOutline(job);
    expect(callStructured).toHaveBeenCalledTimes(1); // still just once
    expect(state.material.structure_outline_result).toBeNull(); // cleared once the fan-out fully succeeds
  });
});
