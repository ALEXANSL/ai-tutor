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

const { runPedagogicalPipeline, ReviewerUnavailableError, verifyProblemNumbers, fillMissingMisconceptions, FALLBACK_MISCONCEPTION_UK, MAX_REVISIONS } = await import("./pipeline");

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

/**
 * ADR-033: `lesson_generation`'s prompt is now `PromptContent` — a plain
 * string for every other role, but a cacheable-prefix + dynamic-tail block
 * list for `lesson_generation` itself (`pipeline.ts`'s `generationPromptContent`).
 * Tests that only care "does the filled text contain X" join the blocks
 * back into one string first, exactly like the model would read them.
 */
function promptText(prompt: unknown): string {
  return typeof prompt === "string" ? prompt : (prompt as { text: string }[]).map((b) => b.text).join("");
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
    expect(promptText((secondGenCall[1] as { prompt: unknown }).prompt)).toContain("бракує гачка");
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

/**
 * ADR-033 item 1: `lesson_generation`'s prompt is split into a static,
 * cacheable prefix (plan + fragments + known_problems) and a dynamic tail
 * (revision notes) so the 2nd/3rd generate→review→revise pass on the SAME
 * block reads that prefix from the prompt cache instead of paying full
 * input price for it again.
 */
describe("lesson_generation prompt caching (ADR-033 item 1)", () => {
  function genPrompt(callIndex: number): { type: string; text: string; cache_control?: { type: string } }[] {
    const call = callStructured.mock.calls.filter((c) => c[0] === "lesson_generation")[callIndex]!;
    return (call[1] as { prompt: { type: string; text: string; cache_control?: { type: string } }[] }).prompt;
  }

  it("sends a cache_control breakpoint on the static prefix, none on the dynamic tail", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()], lesson_review: [review()] });
    await runPedagogicalPipeline(baseInput);
    const prompt = genPrompt(0);
    expect(prompt).toHaveLength(2);
    expect(prompt[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(prompt[1]!.cache_control).toBeUndefined();
  });

  it("the cacheable prefix is byte-identical across a first pass and its revision, only the tail differs", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [block({ titleUk: "Спроба 1" }), block({ titleUk: "Спроба 2" })],
      lesson_review: [review({ verdict: "revise", notes: ["бракує гачка"] }), review({ verdict: "approved" })],
    });
    await runPedagogicalPipeline(baseInput);
    const [firstPass, secondPass] = [genPrompt(0), genPrompt(1)];
    expect(firstPass[0]!.text).toBe(secondPass[0]!.text); // identical prefix -> a real cache hit on pass 2
    expect(secondPass[1]!.text).toContain("бракує гачка");
    expect(firstPass[1]!.text).not.toContain("бракує гачка");
  });

  it("the static prefix carries the plan/fragments/known_problems, never the revision notes", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [block({ titleUk: "Спроба 1" }), block({ titleUk: "Спроба 2" })],
      lesson_review: [review({ verdict: "revise", notes: ["ось конкретне унікальне зауваження"] }), review({ verdict: "approved" })],
    });
    await runPedagogicalPipeline(baseInput);
    const prefix = genPrompt(1)[0]!.text;
    expect(prefix).toContain("Дріб — це..."); // fragments
    expect(prefix).toContain(plan().hookUk); // plan fields
    expect(prefix).not.toContain("ось конкретне унікальне зауваження");
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

/**
 * Prod incident 2026-09-28 (Bug 1): defense-in-depth alongside the
 * strengthened `lesson_generation.md` prompt instruction (the primary fix) —
 * `fillMissingMisconceptions` substitutes a generic fallback for a wrong
 * `choice` option's empty/missing `misconceptionUk` rather than ever letting
 * that fail the whole block's Zod validation (schema.ts no longer requires
 * non-empty there).
 */
describe("fillMissingMisconceptions (Bug 1, 2026-09-28)", () => {
  it("fills an empty-string misconceptionUk on a wrong option with the generic fallback", () => {
    const b = block({
      steps: [
        {
          type: "choice",
          questionUk: "Яка дріб більша?",
          options: [{ id: "a", textUk: "1/2" }, { id: "b", textUk: "1/4", misconceptionUk: "" }],
          correctOptionId: "a",
          explanationUk: "1/2 більша частка",
          sourceRefs: [],
        },
      ],
    });
    const out = fillMissingMisconceptions(b);
    const choiceStep = out.steps[0] as Extract<LessonBlockGenerated["steps"][number], { type: "choice" }>;
    expect(choiceStep.options[1]!.misconceptionUk).toBe(FALLBACK_MISCONCEPTION_UK);
  });

  it("fills a fully-omitted misconceptionUk on a wrong option the same way", () => {
    const b = block({
      steps: [
        {
          type: "choice",
          questionUk: "Яка дріб більша?",
          options: [{ id: "a", textUk: "1/2" }, { id: "b", textUk: "1/4" }],
          correctOptionId: "a",
          explanationUk: "1/2 більша частка",
          sourceRefs: [],
        },
      ],
    });
    const out = fillMissingMisconceptions(b);
    const choiceStep = out.steps[0] as Extract<LessonBlockGenerated["steps"][number], { type: "choice" }>;
    expect(choiceStep.options[1]!.misconceptionUk).toBe(FALLBACK_MISCONCEPTION_UK);
  });

  it("never fills the correct option, even if it somehow has no misconceptionUk", () => {
    const b = block({
      steps: [
        {
          type: "choice",
          questionUk: "Яка дріб більша?",
          options: [{ id: "a", textUk: "1/2" }, { id: "b", textUk: "1/4" }],
          correctOptionId: "a",
          explanationUk: "1/2 більша частка",
          sourceRefs: [],
        },
      ],
    });
    const out = fillMissingMisconceptions(b);
    const choiceStep = out.steps[0] as Extract<LessonBlockGenerated["steps"][number], { type: "choice" }>;
    expect(choiceStep.options[0]!.misconceptionUk).toBeUndefined();
  });

  it("never overwrites a real, already-present misconceptionUk", () => {
    const b = block({
      steps: [
        {
          type: "choice",
          questionUk: "Яка дріб більша?",
          options: [{ id: "a", textUk: "1/2" }, { id: "b", textUk: "1/4", misconceptionUk: "Порівняли лише знаменники" }],
          correctOptionId: "a",
          explanationUk: "1/2 більша частка",
          sourceRefs: [],
        },
      ],
    });
    const out = fillMissingMisconceptions(b);
    const choiceStep = out.steps[0] as Extract<LessonBlockGenerated["steps"][number], { type: "choice" }>;
    expect(choiceStep.options[1]!.misconceptionUk).toBe("Порівняли лише знаменники");
  });

  it("leaves non-choice steps (slide, open, interactive) completely untouched", () => {
    const b = block({ steps: [{ type: "slide", textUk: "текст", sourceRefs: [] }] });
    expect(fillMissingMisconceptions(b)).toEqual(b);
  });

  it("runs automatically inside the pipeline, so an approved block never carries an empty misconceptionUk", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [
        block({
          steps: [
            {
              type: "choice",
              questionUk: "Яка дріб більша?",
              options: [{ id: "a", textUk: "1/2" }, { id: "b", textUk: "1/4", misconceptionUk: "" }],
              correctOptionId: "a",
              explanationUk: "1/2 більша частка",
              sourceRefs: [],
            },
          ],
        }),
      ],
      lesson_review: [review()],
    });
    const res = await runPedagogicalPipeline(baseInput);
    const choiceStep = res.block.steps[0] as Extract<LessonBlockGenerated["steps"][number], { type: "choice" }>;
    expect(choiceStep.options[1]!.misconceptionUk).toBe(FALLBACK_MISCONCEPTION_UK);
  });
});

/**
 * ADR-034 integration tests: the `content_qa` gate runs BEFORE the paid
 * `lesson_review` call, consuming the SAME `MAX_REVISIONS` budget (no new
 * retry limit), and distinguishes `needsReviewReason` ("technical" vs
 * "pedagogical") when retries are exhausted.
 */
describe("content_qa gate inside runPedagogicalPipeline (ADR-034)", () => {
  const brokenBlock = block({
    steps: [{ type: "slide", textUk: "Персонаж вижив завдяки незламній волі до", sourceRefs: [] }], // BUG-011-style dangling cut
  });

  it("a content_qa failure produces a synthetic 'revise' verdict and skips the paid lesson_review call for that iteration", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [brokenBlock, block()],
      lesson_review: [review()],
    });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.status).toBe("active");
    // Two generations happened (broken draft + the fixed retry)...
    expect(callStructured.mock.calls.filter((c) => c[0] === "lesson_generation")).toHaveLength(2);
    // ...but lesson_review was called exactly once — never for the content_qa-failed draft.
    expect(callStructured.mock.calls.filter((c) => c[0] === "lesson_review")).toHaveLength(1);
    expect(res.reviews.map((r) => r.reviewerRole)).toEqual(["content_qa", "lesson_review"]);
    expect(res.reviews[0]!.verdict).toBe("revise");
    expect(res.reviews[0]!.provider).toBe("deterministic");
    // The content_qa failure notes reached the next generation call's prompt.
    const secondGenCall = callStructured.mock.calls.filter((c) => c[0] === "lesson_generation")[1]!;
    expect(promptText((secondGenCall[1] as { prompt: unknown }).prompt)).toMatch(/Крок 1/);
  });

  it("a content_qa failure consumes an existing MAX_REVISIONS slot, not a new/separate budget", async () => {
    // Every single generation attempt is broken -> exhausts MAX_REVISIONS + 1
    // attempts exactly like a fully-failing lesson_review would (existing test above).
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: Array.from({ length: MAX_REVISIONS + 1 }, () => brokenBlock),
    });
    const res = await runPedagogicalPipeline(baseInput);
    expect(callStructured.mock.calls.filter((c) => c[0] === "lesson_generation")).toHaveLength(MAX_REVISIONS + 1);
    expect(callStructured.mock.calls.filter((c) => c[0] === "lesson_review")).toHaveLength(0); // never once paid for review
    expect(res.status).toBe("needs_review");
  });

  it("exhausted retries on content_qa alone -> needs_review with needsReviewReason='technical'", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: Array.from({ length: MAX_REVISIONS + 1 }, () => brokenBlock),
    });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.status).toBe("needs_review");
    expect(res.needsReviewReason).toBe("technical");
  });

  it("exhausted retries on lesson_review alone (content_qa always passing) -> needsReviewReason='pedagogical'", async () => {
    mockRoleQueue({
      lesson_planning: [plan()],
      lesson_generation: [block(), block(), block()],
      lesson_review: [review({ verdict: "revise" }), review({ verdict: "revise" }), review({ verdict: "revise" })],
    });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.status).toBe("needs_review");
    expect(res.needsReviewReason).toBe("pedagogical");
  });

  it("needsReviewReason is null and contentQa.ok is true when a block is approved", async () => {
    mockRoleQueue({ lesson_planning: [plan()], lesson_generation: [block()], lesson_review: [review()] });
    const res = await runPedagogicalPipeline(baseInput);
    expect(res.status).toBe("active");
    expect(res.needsReviewReason).toBeNull();
    expect(res.contentQa?.ok).toBe(true);
  });
});
