/**
 * Pure decisions for nickname / tutor-persona changes (US-1.6 KP-3,
 * US-1.7 KP-1..3, KP-11): what to store, what to log, what to tell the parent.
 */
import {
  validateTutorName,
  type PersonaWordlists,
  type TutorNameError,
} from "@/lib/persona/validation";
import type { PersonaEditable, TutorNameOptions } from "../db/types";

export type Actor = "child" | "parent";

export interface PlannedChange {
  field: "nickname" | "name" | "voice" | "avatar";
  old_value: string | null;
  new_value: string;
  changed_by: Actor;
}

export interface PlannedNotification {
  type: string;
  severity: "normal" | "urgent";
  payload: Record<string, unknown>;
}

export interface Plan {
  update: boolean;
  change?: PlannedChange;
  notification?: PlannedNotification;
}

export function planNicknameChange(previous: string | null, next: string, by: Actor): Plan {
  if (previous === next) return { update: false };
  return {
    update: true,
    change: { field: "nickname", old_value: previous, new_value: next, changed_by: by },
    // The parent is told when the child picks/changes it, to catch a real name (PM-12, R-14).
    notification:
      by === "child"
        ? { type: "nickname_changed", severity: "normal", payload: { nickname: next, previous } }
        : undefined,
  };
}

export function planTutorNameChange(previous: string | null, next: string, by: Actor): Plan {
  if (previous === next) return { update: false };
  return {
    update: true,
    change: { field: "name", old_value: previous, new_value: next, changed_by: by },
    notification:
      by === "child"
        ? { type: "persona_changed", severity: "normal", payload: { field: "name", value: next, previous } }
        : undefined,
  };
}

export type TutorNameChoice =
  | { ok: true; name: string; source: "suggested" | "custom" }
  | { ok: false; error: TutorNameError | "not_suggested"; notifyParent?: PlannedNotification };

export function suggestedNames(options: TutorNameOptions): string[] {
  return [...(options.f ?? []), ...(options.m ?? [])].map((o) => o.name);
}

/**
 * `choice` is "suggested:<name>" or "custom". Suggested names need no check
 * (KP-2) but must really be on the list; custom names go through PM-22 rules.
 * Content rejections (inappropriate / kinship) notify the parent (KP-3).
 */
export function resolveTutorNameChoice(
  input: { choice: string; custom: string },
  options: TutorNameOptions,
  context: { nickname: string | null; wordlists: PersonaWordlists },
): TutorNameChoice {
  if (input.choice.startsWith("suggested:")) {
    const name = input.choice.slice("suggested:".length);
    return suggestedNames(options).includes(name)
      ? { ok: true, name, source: "suggested" }
      : { ok: false, error: "not_suggested" };
  }
  if (input.choice !== "custom") return { ok: false, error: "empty" };
  const result = validateTutorName(input.custom, { nickname: context.nickname, wordlists: context.wordlists });
  if (result.ok) return { ok: true, name: result.value, source: "custom" };
  const contentRejection = result.error === "inappropriate" || result.error === "kinship";
  return {
    ok: false,
    error: result.error,
    notifyParent: contentRejection
      ? {
          type: "tutor_name_rejected",
          severity: "normal",
          payload: { name: input.custom.trim().slice(0, 40), reason: result.error },
        }
      : undefined,
  };
}

export function canChildEdit(editable: PersonaEditable | null | undefined, field: keyof PersonaEditable): boolean {
  // Default is ON (PM-23) when the setting is missing.
  return editable?.[field] ?? true;
}
