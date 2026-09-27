import { describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError } from "@/server/ai/types";
import type { LessonBlockGenerated, LessonPlan, ReviewOutput } from "./schema";

/**
 * ADR-022 pipeline tests (D-55): plan -> generate -> review -> revise, with
 * mocked providers — never a real Anthropic/OpenAI call. Covers the states
 * the backlog explicitly asks `qa-tester` to check: approved first try,
 * "revise" -> a working revision, 2 failed reviews -> `needs_review` (never
 * shown to the child), and a corrupted/unsafe block getting rejected even if
 * the reviewer's own `verdict` field says otherwise.
 */
const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...args: unknown[]) => callStructured(...args) }));

const { runPedagogicalPipeline, ReviewerUnavailableError, verifyProblemNumbers } = await import("./pipeline");

function plan(over: Partial<LessonPlan> = {}): LessonPlan {
  return {
    goalUk: "Навчитися порівнювати дроби",
    hookUk: "Уяви, що піцу ділять двоє друзів...",
    visibleOutcomeUk: "Тепер ти вмієш порівнювати дроби",
    techniques: [
      { key: "retrieval_practice", whyUk: "спершу пригадування" },
      { key: "concrete_to_abstract", whyUk: "від піци до правила" },
    ],
    misconceptionsUk: ["діти порівнюють лише чисельники"],
    toneNotesUk: "тепло, без осуду",
    comprehensionChecksUk: ["чи вміє порівняти дві дроби"],
    ...over,
  };
}

function block(over: Partial<LessonBlockGenerated> = {}): LessonBlockGenerated {
  return {
    titleUk: "Порівняння дробів",
    estimatedMinutes: 7,
    hookUk: "Уяви, що піцу ділять двоє друзів...",
    visibleOutcomeUk: "Тепер ти вмієш порівнювати дроби",
    techniquesUsed: ["retrieval_practice", "concrete_to_abstract"],
    steps: [
      { type: "slide", textUk: "Уяви, що піцу ділять двоє друзів...", sourceRefs: [] },
      { type: "choice", questionUk: "Яка дріб більша?", options: [{ id: "a", textUk: "1/2" }, { id: "b", textUk: "1/4" }], correctOptionId: "a", explanationUk: "1/2 більша частка", sourceRefs: [] },
    ],
    ...over,
  };
}

function review(over: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    verdict: "approved",
    scores: { methodology: 2, factualAccuracy: 2, ageGrade: 2, variety: 2, safety: 2, hook: 2, visibleOutcome: 2, warmth: 2, aesthetics: 2 },
    notes: [],
    summaryUk: "Гарний блок",
    ...over,
  };
}

/** Queues one `{ result, model, costUsd }` response per role, consumed in order. */
function mockRoleQueue(queues: Record<string, unknown[]>) {
  const counters: Record<string, number> = {};
  callStructured.mockImplementation(async (role: string) => {
    const i = counters[role] ?? 0;
    counters[role] = i + 1;
    const q = queues[role];
    if (!q || i >= q.length) throw new Error(`no mocked ${role} response queued for call #${i + 1}`);
    return { result: q[i], model: { provider: role === "lesson_review" ? "openai" : "anthropic", model: role === "lesson_review" ? "gpt-5.6-sol" : "claude-opus-5-5" }, costUsd: 0.01 };
  });
}

// ADR-029: `verifyProblemNumbers` only ever touches `scope` when a step
// actually cites a `problemNumber` — every fixture below leaves `sourceRefs`
// with no `problemNumber`, so this fake never needs to answer a real query.
const fakeScope = {
  select: () => {
    throw new Error("scope.select should not be called when no sourceRef cites a problemNumber");
  },
} as never;

const baseInput = {
  familyId: "fam1",
  topicId: "topic1",
  subjectName: "Математика",
  grade: 6,
  topicTitle: "Дроби",
  fragments: [{ materialId: "m1", materialTitle: "Підручник математики", materialKind: "textbook", page: 12, text: "Дріб — це..." }],
  allowedComponents: [],
  recentTitles: [],
  knownProblems: [],
  scope: fakeScope,
};

describe("runPedagogicalPipeline (ADR-022)", () => {
  it("approves on the first try: exactly one plan, one generation, one review call", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()], lesson_review: [review()] });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.status).toBe("active");
    expect(res.reviewStatus).toBe("first_pass");
    expect(res.reviews).toHaveLength(1);
    expect(callStructured).toHaveBeenCalledTimes(3);
  });

  it("a 'revise' verdict triggers exactly one more generation + review, then approves", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [block({ titleUk: "Спроба 1" }), block({ titleUk: "Спроба 2" })],
      lesson_review: [review({ verdict: "revise", notes: ["бракує гачка"] }), review({ verdict: "approved" })],
    });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.status).toBe("active");
    expect(res.reviewStatus).toBe("revised");
    expect(res.reviews.map((r) => r.verdict)).toEqual(["revise", "approved"]);
    expect(res.block.titleUk).toBe("Спроба 2");
    // The revision notes actually reached the second generation call's prompt.
    const secondGenCall = callStructured.mock.calls.filter((c) => c[0] === "lesson_generation")[1]!;
    expect((secondGenCall[1] as { prompt: string }).prompt).toContain("бракує гачка");
  });

  it("two failed reviews in a row -> needs_review, never shown to the child, after exactly 3 generations", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [block(), block(), block()],
      lesson_review: [review({ verdict: "revise" }), review({ verdict: "revise" }), review({ verdict: "revise" })],
    });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.status).toBe("needs_review");
    expect(res.reviewStatus).toBe("needs_review");
    expect(res.reviews).toHaveLength(3);
    expect(callStructured.mock.calls.filter((c) => c[0] === "lesson_generation")).toHaveLength(3);
  });

  it("a corrupted block (safety violation) is rejected even if the reviewer's own verdict field says approved", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [block(), block()],
      lesson_review: [
        review({ verdict: "approved", scores: { ...review().scores, safety: 0 } }), // corrupted/inconsistent reviewer output
        review({ verdict: "approved" }),
      ],
    });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.reviews[0]!.verdict).toBe("rejected"); // enforced, not the raw "approved"
    expect(res.status).toBe("active"); // second attempt genuinely passed
    expect(res.reviews).toHaveLength(2);
  });

  it("labels textbook fragments ahead of book fragments and tells the model the textbook wins on conflict (BUG-010)", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()], lesson_review: [review()] });
    await runPedagogicalPipeline({
      ...baseInput,
      fragments: [
        { materialId: "b1", materialTitle: "Цікава книга", materialKind: "popular_science", page: 3, text: "У книзі сказано інакше" },
        { materialId: "m1", materialTitle: "Підручник", materialKind: "textbook", page: 12, text: "У підручнику сказано так" },
      ],
    });
    const planCall = callStructured.mock.calls.find((c) => c[0] === "lesson_planning")!;
    const prompt = (planCall[1] as { prompt: string }).prompt;
    const textbookIdx = prompt.indexOf("ПІДРУЧНИК");
    const bookIdx = prompt.indexOf("КНИГА");
    expect(textbookIdx).toBeGreaterThanOrEqual(0);
    expect(bookIdx).toBeGreaterThanOrEqual(0);
    expect(textbookIdx).toBeLessThan(bookIdx);
  });

  it("BUG-011: an unconfigured reviewer (e.g. OPENAI_API_KEY missing) throws a translated ReviewerUnavailableError, not a raw AiNotConfiguredError", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()] });
    callStructured.mockImplementation(async (role: string) => {
      if (role === "lesson_planning") return { result: plan(), model: { provider: "anthropic", model: "claude-opus-5-5" }, costUsd: 0.01 };
      if (role === "lesson_generation") return { result: block(), model: { provider: "anthropic", model: "claude-opus-5-5" }, costUsd: 0.01 };
      throw new AiNotConfiguredError("OPENAI_API_KEY is not set");
    });
    await expect(runPedagogicalPipeline(baseInput)).rejects.toThrow(ReviewerUnavailableError);
    await expect(runPedagogicalPipeline(baseInput)).rejects.toThrow("рецензент недоступний: не налаштовано OPENAI_API_KEY");
  });
});

describe("runPedagogicalPipeline stage hooks (ADR-023 §Частина 1.6/1.7 — the child's progress screen)", () => {
  it("reports planning -> generating -> reviewing, in order, on a first-try approval", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()], lesson_review: [review()] });
    const stages: string[] = [];
    await runPedagogicalPipeline(baseInput, { onStage: async (s) => void stages.push(s) });
    expect(stages).toEqual(["planning", "generating", "reviewing"]);
  });

  it("reports 'revising' (not 'generating' again) before the second generation call after a 'revise' verdict", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [block({ titleUk: "Спроба 1" }), block({ titleUk: "Спроба 2" })],
      lesson_review: [review({ verdict: "revise", notes: ["бракує гачка"] }), review({ verdict: "approved" })],
    });
    const stages: string[] = [];
    await runPedagogicalPipeline(baseInput, { onStage: async (s) => void stages.push(s) });
    expect(stages).toEqual(["planning", "generating", "reviewing", "revising", "reviewing"]);
  });

  it("tags every callStructured call with the job id when running from a background job", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()], lesson_review: [review()] });
    await runPedagogicalPipeline(baseInput, { jobId: "job-1", onStage: async () => {} });
    for (const call of callStructured.mock.calls) {
      expect((call[2] as { jobId?: string }).jobId).toBe("job-1");
    }
  });

  it("never breaks when hooks are omitted (plain, non-job pipeline run)", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()], lesson_review: [review()] });
    await expect(runPedagogicalPipeline(baseInput)).resolves.toMatchObject({ status: "active" });
  });
});

/**
 * BUG-041: `verifyProblemNumbers` is the anti-hallucination guard (ADR-029
 * §1) that nulls out a step's `sourceRefs[].problemNumber` unless it exactly
 * matches a `material_problems` row — direct unit tests, exercising the
 * DB-lookup/nulling branch itself, rather than only fixtures that skip it.
 */
describe("verifyProblemNumbers (ADR-029 §1, BUG-041)", () => {
  /** A minimal fake of the `scope.select(...).in(...).returns()` chain `verifyProblemNumbers` actually calls. */
  function scopeWithMaterialProblems(rows: { material_id: string; page: number; number: string }[]) {
    return {
      select: () => ({
        in: () => ({
          returns: async () => ({ data: rows }),
        }),
      }),
    } as never;
  }

  it("nulls a problemNumber that has no matching material_problems row", async () => {
    const scope = scopeWithMaterialProblems([{ material_id: "m1", page: 42, number: "117" }]);
    const b = block({
      steps: [{ type: "slide", textUk: "...", sourceRefs: [{ materialId: "m1", materialTitle: "Math", page: 42, problemNumber: "999" }] }],
    });
    const out = await verifyProblemNumbers(scope, b);
    expect(out.steps[0]!.sourceRefs[0]!.problemNumber).toBeNull();
  });

  it("keeps a problemNumber that exactly matches a material_problems row (material+page+number)", async () => {
    const scope = scopeWithMaterialProblems([{ material_id: "m1", page: 42, number: "117" }]);
    const b = block({
      steps: [{ type: "slide", textUk: "...", sourceRefs: [{ materialId: "m1", materialTitle: "Math", page: 42, problemNumber: "117" }] }],
    });
    const out = await verifyProblemNumbers(scope, b);
    expect(out.steps[0]!.sourceRefs[0]!.problemNumber).toBe("117");
  });

  it("is a no-op (and never queries the DB) when no sourceRef cites a problemNumber", async () => {
    const out = await verifyProblemNumbers(fakeScope, block());
    expect(out).toEqual(block());
  });
});
