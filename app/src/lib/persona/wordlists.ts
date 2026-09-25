import raw from "@config/persona-wordlists.json";
import type { PersonaWordlists } from "./validation";

/** Word lists from configuration (PM-22). Not secret: also used for client-side hints. */
export const personaWordlists: PersonaWordlists = {
  kinshipWords: raw.kinshipWords,
  kinshipPhrases: raw.kinshipPhrases,
  inappropriateWords: raw.inappropriateWords,
  inappropriateStems: raw.inappropriateStems,
};
