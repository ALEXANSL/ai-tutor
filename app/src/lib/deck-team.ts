import { z } from "zod";

/**
 * ADR-052: the lesson team that writes a narrated deck. Each role is one model
 * call; its answer is saved on the deck so a failed step resumes where it stopped.
 * Schemas use only required fields (OpenAI strict JSON schema and Claude
 * structured output both accept them).
 */
export const DECK_TEAM_ROLES = ["analyst", "council", "teacher", "art", "review", "editor"] as const;
export type DeckTeamRole = (typeof DECK_TEAM_ROLES)[number];

export const factSheetSchema = z.object({
  subject: z.string(),
  topic: z.string(),
  textbookGoals: z.array(z.string()),
  keyFacts: z.array(z.object({ fact: z.string(), evidence: z.string() })),
  terms: z.array(z.object({ term: z.string(), meaning: z.string() })),
  people: z.array(z.object({ name: z.string(), who: z.string() })),
  places: z.array(z.object({ name: z.string(), why: z.string() })),
  dates: z.array(z.object({ when: z.string(), what: z.string() })),
  quotes: z.array(z.string()),
  doubts: z.array(z.string()),
});
export type FactSheet = z.infer<typeof factSheetSchema>;

export const teachingBriefSchema = z.object({
  goals: z.object({ know: z.array(z.string()), understand: z.array(z.string()), able: z.array(z.string()) }),
  bigIdeas: z.array(z.string()),
  misconceptions: z.array(z.object({ belief: z.string(), correction: z.string() })),
  hook: z.string(),
  associations: z.array(z.object({ idea: z.string(), fromChildLife: z.string() })),
  emotionalArc: z.string(),
  ageNotes: z.string(),
  expertNotes: z.string(),
  slidePlan: z.array(z.object({ purpose: z.string(), idea: z.string(), image: z.string() })),
  checkQuestions: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export type TeachingBrief = z.infer<typeof teachingBriefSchema>;

export const scriptSchema = z.object({ slides: z.array(z.object({ heading: z.string(), takeaway: z.string(), narration: z.string() })) });
export type DeckScript = z.infer<typeof scriptSchema>;

export const REVIEW_CRITERIA = ["facts", "coverage", "age", "pedagogy", "voice", "visuals"] as const;
export const REVIEW_LABELS: Record<(typeof REVIEW_CRITERIA)[number], string> = {
  facts: "Факти", coverage: "Повнота теми", age: "Вік і тон", pedagogy: "Методика", voice: "Живий голос", visuals: "Картинки",
};
export const deckReviewSchema = z.object({
  verdict: z.enum(["ok", "revise"]),
  scores: z.object({ facts: z.number(), coverage: z.number(), age: z.number(), pedagogy: z.number(), voice: z.number(), visuals: z.number() }),
  summary: z.string(),
  fixes: z.array(z.object({ slide: z.number(), problem: z.string(), fix: z.string() })),
});
export type DeckReview = z.infer<typeof deckReviewSchema>;

/** A score of 3 or less on any criterion, or listed fixes, sends the deck to the editor once. */
export function needsEditing(review: DeckReview) {
  return review.verdict === "revise" || review.fixes.length > 0 || REVIEW_CRITERIA.some(key => review.scores[key] <= 3);
}

export interface DeckTeamState {
  factSheet?: FactSheet;
  brief?: TeachingBrief;
  script?: DeckScript;
  /** Script plus the art director's visuals, before review. */
  draft?: { slides: unknown[] };
  review?: DeckReview;
  edited?: boolean;
  /** Roles whose primary model failed; the next attempt uses the role's reserve model. */
  fallback?: DeckTeamRole[];
  /** Model that actually answered for each finished role ("provider/model"). */
  models?: Partial<Record<DeckTeamRole, string>>;
}

export const DECK_TEAM_STAGE: Record<DeckTeamRole, string> = {
  analyst: "Аналітик джерел складає паспорт фактів уроку.",
  council: "Педагогічна рада (методист, предметник, психолог) продумує урок.",
  teacher: "Учитель-оповідач пише слайди й текст диктора.",
  art: "Художній директор добирає карти, фото й ілюстрації.",
  review: "Незалежний рецензент перевіряє факти, вік і методику.",
  editor: "Редактор виправляє зауваження рецензента.",
};

/** The next role to run, or undefined when the plan is ready. */
export function nextTeamRole(team: DeckTeamState | undefined): DeckTeamRole | undefined {
  if (!team?.factSheet) return "analyst";
  if (!team.brief) return "council";
  if (!team.script) return "teacher";
  if (!team.draft) return "art";
  if (!team.review) return "review";
  if (!team.edited && needsEditing(team.review)) return "editor";
  return undefined;
}
