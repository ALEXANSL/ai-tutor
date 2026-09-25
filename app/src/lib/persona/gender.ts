/**
 * Tutor grammatical gender (US-1.7 KP-4, KP-10; docs/02 7.6.1; BUG-002).
 *
 * - Before a voice is chosen (S0..S11, or a child who never changes the
 *   default voice) the gender follows the NAME choice: the group of a
 *   suggested name, or the child's explicit "Вона / Він" for an own name
 *   (default female, D-18). Stored in child_profile.tutor_name_gender.
 * - Once a voice is chosen (S12) the voice's gender wins (PM-21).
 *
 * Every gendered UI text goes through `gendered()` so the rule lives in one
 * place. Client-safe: no server imports.
 */
import type { TutorGender } from "@/i18n/uk";
import type { TutorNameOptions } from "@/server/db/types";

export const DEFAULT_TUTOR_GENDER: TutorGender = "f";

export function isTutorGender(value: unknown): value is TutorGender {
  return value === "f" || value === "m";
}

/** Parses a form value; anything unexpected falls back to the default (female). */
export function parseTutorGender(value: unknown): TutorGender {
  return isTutorGender(value) ? value : DEFAULT_TUTOR_GENDER;
}

/** Gender of a name from the suggestion list, or null when it is not on the list. */
export function genderOfSuggestedName(options: TutorNameOptions, name: string): TutorGender | null {
  if ((options.f ?? []).some((o) => o.name === name)) return "f";
  if ((options.m ?? []).some((o) => o.name === name)) return "m";
  return null;
}

/** Voice gender (S12) wins; otherwise the gender stored with the name; otherwise female. */
export function resolveTutorGender(input: {
  voiceGender?: TutorGender | null;
  nameGender?: TutorGender | null;
}): TutorGender {
  if (isTutorGender(input.voiceGender)) return input.voiceGender;
  if (isTutorGender(input.nameGender)) return input.nameGender;
  return DEFAULT_TUTOR_GENDER;
}

/** The single helper for every text that agrees with the tutor's gender. */
export function gendered<T>(gender: TutorGender, forms: Record<TutorGender, T>): T {
  return forms[gender];
}
