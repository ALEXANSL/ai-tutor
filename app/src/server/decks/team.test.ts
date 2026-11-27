import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NarratedDeck } from "@/lib/narrated-deck";
import type { DeckReview } from "@/lib/deck-team";

const f = vi.hoisted(() => ({ call: vi.fn(), update: vi.fn(), material: vi.fn(), route: vi.fn(), upsert: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/ai/router", () => ({ callStructured: f.call, defaultRouterDeps: { providers: { structured: {} } } }));
vi.mock("./store", () => ({ updateDeck: f.update }));
vi.mock("./lesson-content", () => ({ lessonSlideSource: f.material }));
vi.mock("@/server/studio/gemini", () => ({ geminiStudio: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ from: () => ({ upsert: f.upsert }) }) }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => ({ eq: () => ({ maybeSingle: f.route }) }) }) }));
import { runDeckTeamStep, deckTeamSystem, DECK_TEAM_ROUTES } from "./team";
import { ProviderError } from "@/server/ai/types";

let deck: NarratedDeck;
const step = () => runDeckTeamStep("family", "deck", deck, deck.generated!);
const route = (role: string) => {
  const plan = DECK_TEAM_ROUTES[role.replace("deck.", "") as keyof typeof DECK_TEAM_ROUTES];
  return { role, primary_provider: plan.primary.provider, primary_model: plan.primary.model, fallback_provider: plan.fallback.provider, fallback_model: plan.fallback.model, params: {} };
};
const slide = { heading: "Олімп", takeaway: "Боги жили на Олімпі", narration: "Уяви гору до неба…" };
const visual = { visualType: "map", places: [{ name: "Олімп", lat: 40.08, lon: 22.36 }], photoQuery: "", imagePrompt: " ", caption: "Знайди Олімп." };
const review = (patch: Partial<DeckReview> = {}): DeckReview => ({ verdict: "ok", scores: { facts: 5, coverage: 5, age: 5, pedagogy: 4, voice: 5, visuals: 4 }, summary: "Добре.", fixes: [], ...patch });
const answers: Record<string, unknown> = {
  "deck.analyst": { subject: "Історія", topic: "Міфи", textbookGoals: [], keyFacts: [{ fact: "Олімп — гора", evidence: "гора Олімп" }], terms: [], people: [], places: [], dates: [], quotes: [], doubts: [] },
  "deck.council": { goals: { know: [], understand: [], able: [] }, bigIdeas: ["Боги"], misconceptions: [], hook: "Загадка", associations: [], emotionalArc: "", ageNotes: "", expertNotes: "", slidePlan: [{ purpose: "гачок", idea: "Олімп", image: "Mount Olympus" }], checkQuestions: [] },
  "deck.teacher": { slides: [slide] },
  "deck.art": { visuals: [visual] },
};

beforeEach(() => {
  vi.resetAllMocks();
  deck = { driveId: "", subjectId: "s", state: "processing", title: "Міфи Греції", revision: 0, slides: [], error: "", published: false, generated: { href: "/l/1", wishes: "" } };
  f.material.mockResolvedValue("Текст уроку про Олімп");
  f.upsert.mockResolvedValue({ error: null });
  let current = "";
  f.route.mockImplementation(async () => ({ data: route(current), error: null }));
  f.call.mockImplementation(async (role: string, _req, _ctx, deps) => {
    const r = await deps.loadRoute();
    return { result: answers[role], model: { provider: r.primary_provider, model: r.primary_model } };
  });
  f.upsert.mockImplementation(async (row: { role?: string }) => { if (row.role) current = row.role; return { error: null }; });
  f.update.mockImplementation(async (_f, _id, prev, patch) => { deck = { ...prev, ...patch, revision: prev.revision + 1 }; return deck; });
});

describe("lesson team (ADR-052)", () => {
  it("runs analyst, council, teacher, art director and reviewer as separate saved steps across three AIs", async () => {
    answers["deck.review"] = review();
    for (let i = 0; i < 5; i++) await expect(step()).resolves.toEqual({ requeue: true });
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["deck.analyst", "deck.council", "deck.teacher", "deck.art", "deck.review"]);
    expect(deck.generated?.team?.models).toEqual({ analyst: "gemini/gemini-3.1-flash-lite", council: "anthropic/claude-opus-5-5", teacher: "anthropic/claude-opus-5-5", art: "openai/gpt-5.4", review: "openai/gpt-5.4" });
    // The reviewer sees the whole lesson, not only the analyst's summary.
    expect(JSON.parse(f.call.mock.calls[4]![1].prompt).lesson).toContain("Олімп");
    expect(f.call.mock.calls[4]![1].system).toContain("незалежний рецензент");
    expect(deck.generated?.plan?.slides).toEqual([{ ...slide, ...visual, imagePrompt: "" }]);
    expect(deck.generated?.team?.edited).toBeUndefined();
  });

  it("sends a deck with fixes to the editor once and keeps places only on map slides", async () => {
    answers["deck.review"] = review({ verdict: "revise", fixes: [{ slide: 1, problem: "Немає питання", fix: "Додай питання" }] });
    answers["deck.editor"] = { slides: [{ ...slide, ...visual, visualType: "photo", narration: "А як думаєш?" }] };
    for (let i = 0; i < 5; i++) await step();
    expect(deck.generated?.plan).toBeUndefined();
    await step();
    expect(f.call.mock.calls.at(-1)![0]).toBe("deck.editor");
    expect(JSON.parse(f.call.mock.calls.at(-1)![1].prompt).review.fixes).toHaveLength(1);
    expect(deck.generated?.team?.edited).toBe(true);
    expect(deck.generated?.plan?.slides[0]).toMatchObject({ narration: "А як думаєш?", visualType: "photo", places: [] });
  });

  it("retries a temporary failure once, then hands the role to its reserve model", async () => {
    f.call.mockRejectedValueOnce(new ProviderError("overloaded", "gemini", 503, true));
    await expect(step()).rejects.toThrow("overloaded");
    deck = { ...deck, retry: { failures: 1, reason: "", at: "" } };
    f.call.mockRejectedValueOnce(new ProviderError("overloaded", "gemini", 503, true));
    await step();
    expect(deck.generated?.team?.fallback).toEqual(["analyst"]);
    await step();
    expect(deck.generated?.team?.models?.analyst).toBe("openai/gpt-5.4");
  });

  it("gives every role the shared charter about an 11–12-year-old and the picture rules where pictures are judged", () => {
    for (const role of ["analyst", "council", "teacher", "art", "review", "editor"] as const) expect(deckTeamSystem(role)).toContain("11–12 років");
    expect(deckTeamSystem("art")).toContain("піраміди");
    expect(deckTeamSystem("teacher")).not.toContain("піраміди");
  });
});
