import "server-only";
import { validateNickname, type NicknameError, type TutorNameError } from "@/lib/persona/validation";
import { personaWordlists } from "@/lib/persona/wordlists";
import { forFamily, type FamilyScope } from "../db/family-scope";
import type { ChildProfileRow, ParentSettingsRow } from "../db/types";
import { notifyParent } from "../notifications";
import {
  canChildEdit,
  planNicknameChange,
  planTutorNameChange,
  resolveTutorNameChoice,
  type Actor,
  type Plan,
} from "./plan";

export type PersonaResult<E extends string> = { ok: true } | { ok: false; error: E };

async function loadProfile(scope: FamilyScope, profileId?: string): Promise<ChildProfileRow> {
  let query = scope.select("child_profile");
  if (profileId) query = query.eq("id", profileId);
  const { data, error } = await query.limit(1).maybeSingle<ChildProfileRow>();
  if (error || !data) throw new Error("child profile not found");
  return data;
}

export async function loadParentSettings(scope: FamilyScope): Promise<ParentSettingsRow> {
  const { data, error } = await scope.select("parent_settings").maybeSingle<ParentSettingsRow>();
  if (error || !data) throw new Error("parent settings not found");
  return data;
}

async function applyPlan(
  scope: FamilyScope,
  profile: ChildProfileRow,
  plan: Plan,
  values: Partial<ChildProfileRow>,
): Promise<void> {
  if (!plan.update) return;
  const { error } = await scope.update("child_profile", values).eq("id", profile.id);
  if (error) throw new Error(`child_profile update failed: ${error.message}`);
  if (plan.change) {
    const { error: logError } = await scope.insert("persona_changes", { child_profile_id: profile.id, ...plan.change });
    if (logError) throw new Error(`persona_changes insert failed: ${logError.message}`);
  }
  if (plan.notification) await notifyParent(scope, plan.notification);
}

export async function changeNickname(
  familyId: string,
  raw: string,
  by: Actor,
  profileId?: string,
): Promise<PersonaResult<NicknameError>> {
  const result = validateNickname(raw);
  if (!result.ok) return result;
  const scope = forFamily(familyId);
  const profile = await loadProfile(scope, profileId);
  await applyPlan(scope, profile, planNicknameChange(profile.nickname, result.value, by), {
    nickname: result.value,
  });
  return { ok: true };
}

export async function changeTutorName(
  familyId: string,
  input: { choice: string; custom: string; gender?: string },
  by: Actor,
  options: { profileId?: string; firstTime?: boolean } = {},
): Promise<PersonaResult<TutorNameError | "not_suggested" | "not_allowed">> {
  const scope = forFamily(familyId);
  const [profile, settings] = await Promise.all([loadProfile(scope, options.profileId), loadParentSettings(scope)]);

  // Onboarding always lets the child pick the first name; later edits respect PM-23.
  if (by === "child" && !options.firstTime && !canChildEdit(settings.persona_child_editable, "name")) {
    return { ok: false, error: "not_allowed" };
  }
  const choice = resolveTutorNameChoice(input, settings.tutor_name_options, {
    nickname: profile.nickname,
    wordlists: personaWordlists,
  });
  if (!choice.ok) {
    if (choice.notifyParent && by === "child") await notifyParent(scope, choice.notifyParent);
    return { ok: false, error: choice.error };
  }
  const previous = { name: profile.tutor_name, gender: profile.tutor_name_gender };
  const next = { name: choice.name, gender: choice.gender };
  await applyPlan(scope, profile, planTutorNameChange(previous, next, by), {
    tutor_name: choice.name,
    tutor_name_source: choice.source,
    tutor_name_gender: choice.gender,
    persona_updated_at: new Date().toISOString(),
  });
  return { ok: true };
}

export async function completeOnboarding(familyId: string, profileId: string): Promise<void> {
  const scope = forFamily(familyId);
  const { error } = await scope
    .update("child_profile", { onboarding_completed_at: new Date().toISOString() })
    .eq("id", profileId)
    .is("onboarding_completed_at", null)
    .not("nickname", "is", null)
    .not("tutor_name", "is", null);
  if (error) throw new Error(`completeOnboarding failed: ${error.message}`);
}

export async function setPersonaChildEditable(familyId: string, editable: boolean): Promise<void> {
  const scope = forFamily(familyId);
  const { error } = await scope.update("parent_settings", {
    persona_child_editable: { name: editable, voice: editable, avatar: editable },
  });
  if (error) throw new Error(`persona_child_editable update failed: ${error.message}`);
}
