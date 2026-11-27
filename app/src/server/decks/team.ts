import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { callStructured, defaultRouterDeps, type ProviderAdapters } from "@/server/ai/router";
import { AiNotConfiguredError, ProviderError, type ModelRoute } from "@/server/ai/types";
import { createServiceClient } from "@/server/supabase/clients";
import { forFamily } from "@/server/db/family-scope";
import { geminiStudio } from "@/server/studio/gemini";
import { outlineSchema, slideVisualsSchema } from "@/lib/lesson-slide-plan";
import {
  deckReviewSchema, factSheetSchema, needsEditing, scriptSchema, teachingBriefSchema,
  type DeckTeamRole, type DeckTeamState,
} from "@/lib/deck-team";
import type { NarratedDeck } from "@/lib/narrated-deck";
import { IMAGE_RULES } from "./image-rules";
import { lessonSlideSource } from "./lesson-content";
import { updateDeck } from "./store";

type Model = { provider: "anthropic" | "openai" | "gemini"; model: string };
const OPUS: Model = { provider: "anthropic", model: "claude-opus-5-5" };
const GPT: Model = { provider: "openai", model: "gpt-5.4" };
const GEMINI: Model = { provider: "gemini", model: "gemini-3.1-flash-lite" };

/** ADR-052: who plays each role, the reserve model, and the output allowance. Seeded once per
 * family into `model_routes` (role `deck.<name>`); an edited row there wins. */
export const DECK_TEAM_ROUTES: Record<DeckTeamRole, { primary: Model; fallback: Model; maxTokens: number }> = {
  analyst: { primary: GEMINI, fallback: GPT, maxTokens: 12000 },
  council: { primary: OPUS, fallback: GPT, maxTokens: 10000 },
  teacher: { primary: OPUS, fallback: GPT, maxTokens: 14000 },
  art: { primary: GPT, fallback: OPUS, maxTokens: 8000 },
  review: { primary: GPT, fallback: OPUS, maxTokens: 8000 },
  editor: { primary: OPUS, fallback: GPT, maxTokens: 16000 },
};
/** One call per background step; the worker has 300 s, so a step never waits for two models. */
const TIMEOUT_MS = 170_000;
const PRICES = [
  { provider: "openai", model: "gpt-5.4", input_usd_per_mtok: 2.5, output_usd_per_mtok: 15, cache_read_usd_per_mtok: 0.25, notes: "GPT-5.4 <=272K tokens; docs/03." },
  { provider: "anthropic", model: "claude-opus-5-5", input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_read_usd_per_mtok: 0.2, notes: "docs/03 2.1" },
  { provider: "gemini", model: "gemini-3.1-flash-lite", input_usd_per_mtok: 0.25, output_usd_per_mtok: 1.5, notes: "Workshop source and design, docs/03." },
];

let sections: Record<string, string> | undefined;
/** The charter plus the role's section of prompts/deck_team.md (Alex edits the file as text). */
export function deckTeamSystem(role: DeckTeamRole) {
  if (!sections) {
    const text = readFileSync(join(process.cwd(), "prompts/deck_team.md"), "utf8");
    sections = Object.fromEntries(text.split(/^## /m).slice(1).map(part => {
      const newline = part.indexOf("\n");
      return [part.slice(0, newline).trim(), part.slice(newline + 1).trim()];
    }));
  }
  const charter = sections.charter, own = sections[role];
  if (!charter || !own) throw new Error(`prompts/deck_team.md has no "${role}" section.`);
  const pictures = role === "art" || role === "review" || role === "editor" ? `\n\nПравила зображень:\n${IMAGE_RULES}` : "";
  return `${charter}\n\n${own}${pictures}`;
}

async function teamRoute(familyId: string, role: DeckTeamRole): Promise<ModelRoute> {
  const db = createServiceClient();
  const plan = DECK_TEAM_ROUTES[role];
  const prices = await db.from("model_prices").upsert(PRICES, { onConflict: "provider,model", ignoreDuplicates: true });
  if (prices.error) throw new AiNotConfiguredError("deck_team_price");
  const seeded = await db.from("model_routes").upsert({
    family_id: familyId, role: `deck.${role}`,
    primary_provider: plan.primary.provider, primary_model: plan.primary.model,
    fallback_provider: plan.fallback.provider, fallback_model: plan.fallback.model,
    params: { max_tokens: plan.maxTokens, effort: "medium", timeout_ms: TIMEOUT_MS, budget_policy: "primary" },
  }, { onConflict: "family_id,role", ignoreDuplicates: true });
  if (seeded.error) throw new AiNotConfiguredError("deck_team_route");
  const { data, error } = await forFamily(familyId).select("model_routes", "*").eq("role", `deck.${role}`).maybeSingle<ModelRoute>();
  if (error || !data) throw new AiNotConfiguredError("deck_team_route_read");
  return data;
}

/** The workshop's Gemini adapter answers with an envelope; a failed answer is a provider error here. */
const gemini: ProviderAdapters["structured"][string] = async req => {
  const { data, usage } = await geminiStudio(req);
  if (data.failure) throw new ProviderError(`gemini ${data.failure.code}`, "gemini", 200, true);
  return { data: data.result, usage };
};

/** One role, one model: the route's primary, or its reserve after the primary failed (no
 * in-call fallback, so a step never runs two long calls inside one worker). */
export async function callDeckTeam<S extends z.ZodType>(
  familyId: string, deckId: string, role: DeckTeamRole, reserve: boolean,
  request: { system: string; prompt: string; schema: S },
) {
  const route = await teamRoute(familyId, role);
  const pick = reserve && route.fallback_provider && route.fallback_model
    ? { provider: route.fallback_provider, model: route.fallback_model }
    : { provider: route.primary_provider, model: route.primary_model };
  if (!["anthropic", "openai", "gemini"].includes(pick.provider)) throw new AiNotConfiguredError(`deck_team_provider_${pick.provider}`);
  const single: ModelRoute = { ...route, primary_provider: pick.provider, primary_model: pick.model, fallback_provider: null, fallback_model: null, escalation_provider: null, escalation_model: null };
  const answer = await callStructured(route.role, request, { familyId, ref: { table: "jobs", id: deckId } }, {
    ...defaultRouterDeps,
    loadRoute: async () => single,
    providers: { ...defaultRouterDeps.providers, structured: { ...defaultRouterDeps.providers.structured, gemini } },
  });
  return { result: request.schema.parse(answer.result) as z.infer<S>, model: `${answer.model.provider}/${answer.model.model}` };
}

type Generated = NonNullable<NarratedDeck["generated"]>;

/** Runs the next role of the team (ADR-052) and saves its answer; the last role saves the plan. */
export async function runDeckTeamStep(family: string, id: string, deck: NarratedDeck, generated: Generated) {
  const team: DeckTeamState = generated.team ?? {};
  const material = await lessonSlideSource(family, generated.href);
  const base = { title: deck.title, wishes: generated.wishes };
  const role: DeckTeamRole = !team.factSheet ? "analyst" : !team.brief ? "council" : !team.script ? "teacher" : !team.draft ? "art"
    : !team.review ? "review" : "editor";
  const reserve = !!team.fallback?.includes(role);
  const call = <S extends z.ZodType>(prompt: unknown, schema: S) =>
    callDeckTeam(family, id, role, reserve, { system: deckTeamSystem(role), prompt: JSON.stringify(prompt), schema });
  const save = (patch: DeckTeamState, plan?: Generated["plan"]) =>
    updateDeck(family, id, deck, { retry: null, generated: { ...generated, team: { ...team, ...patch }, ...(plan ? { plan } : {}) } });
  try {
    if (role === "analyst") {
      const answer = await call({ ...base, lesson: material.slice(0, 120000) }, factSheetSchema);
      await save({ factSheet: answer.result, models: { ...team.models, analyst: answer.model } });
    } else if (role === "council") {
      const answer = await call({ ...base, factSheet: team.factSheet, lesson: material.slice(0, 24000) }, teachingBriefSchema);
      await save({ brief: answer.result, models: { ...team.models, council: answer.model } });
    } else if (role === "teacher") {
      const answer = await call({ ...base, brief: team.brief, factSheet: team.factSheet }, scriptSchema);
      const slides = answer.result.slides.map(s => ({ heading: s.heading.trim(), takeaway: s.takeaway.trim(), narration: s.narration.trim() }));
      if (!slides.length || slides.length > 20 || slides.some(s => !s.heading || !s.takeaway || !s.narration)) throw new Error("ШІ повернув неповний план презентації.");
      await save({ script: { slides }, models: { ...team.models, teacher: answer.model } });
    } else if (role === "art") {
      const slides = team.script!.slides;
      const answer = await call({ title: deck.title, imageIdeas: team.brief?.slidePlan.map(p => p.image), slides }, slideVisualsSchema);
      const { visuals } = answer.result;
      if (visuals.length !== slides.length) throw new Error("ШІ повернув неповний опис ілюстрацій.");
      const draft = slides.map((s, i) => ({ ...s, ...visuals[i]! }));
      await save({ draft: { slides: draft }, models: { ...team.models, art: answer.model } });
    } else if (role === "review") {
      const answer = await call({ title: deck.title, lesson: material.slice(0, 80000), factSheet: team.factSheet, brief: team.brief, slides: team.draft!.slides }, deckReviewSchema);
      const review = answer.result;
      const done = !needsEditing(review);
      await save({ review, models: { ...team.models, review: answer.model } }, done ? finalPlan(team.draft!.slides) : undefined);
    } else {
      const answer = await call({ title: deck.title, brief: team.brief, factSheet: team.factSheet, review: team.review, slides: team.draft!.slides }, outlineSchema);
      const slides = answer.result.slides;
      if (!slides.length || slides.length > 20 || slides.some(s => !s.heading.trim() || !s.takeaway.trim() || !s.narration.trim())) throw new Error("ШІ повернув неповний план презентації.");
      await save({ edited: true, models: { ...team.models, editor: answer.model } }, finalPlan(slides));
    }
  } catch (error) {
    // A refused or broken primary hands the role to its reserve model on the next step; a
    // temporary failure gets one ordinary retry first (ADR-052).
    const switchable = error instanceof AiNotConfiguredError || error instanceof ProviderError;
    const transient = error instanceof ProviderError && error.retryable && !(deck.retry?.failures);
    if (!switchable || transient || reserve) throw error;
    await updateDeck(family, id, deck, { retry: null, generated: { ...generated, team: { ...team, fallback: [...(team.fallback ?? []), role] } } });
  }
  return { requeue: true as const };
}

function finalPlan(slides: unknown[]) {
  const parsed = outlineSchema.parse({ slides });
  return { slides: parsed.slides.map(s => ({ ...s, heading: s.heading.trim(), takeaway: s.takeaway.trim(), narration: s.narration.trim(), imagePrompt: s.imagePrompt.trim(), caption: s.caption.trim(), places: s.visualType === "map" ? s.places : [] })) };
}
