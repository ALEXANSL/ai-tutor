import "server-only";
import type { TutorGender } from "@/i18n/uk";
import { forFamily } from "../db/family-scope";
import type { ChildProfileRow, PersonaEditable, TutorNameOptions } from "../db/types";

/**
 * Child-facing persona settings. The child has no RLS access to
 * parent_settings, so the server reads only the fields the child UI needs.
 */
export async function getChildPersonaSettings(
  familyId: string,
): Promise<{ options: TutorNameOptions; editable: PersonaEditable }> {
  const { data, error } = await forFamily(familyId)
    .select("parent_settings", "tutor_name_options, persona_child_editable")
    .maybeSingle<{ tutor_name_options: TutorNameOptions; persona_child_editable: PersonaEditable }>();
  if (error || !data) throw new Error("parent settings not found");
  return {
    options: { f: data.tutor_name_options?.f ?? [], m: data.tutor_name_options?.m ?? [] },
    editable: data.persona_child_editable,
  };
}

/** Grammatical gender follows the chosen voice (PM-21); default voice is female (D-18). */
export async function getTutorGender(familyId: string, profile: Pick<ChildProfileRow, "tutor_voice_id">): Promise<TutorGender> {
  if (!profile.tutor_voice_id) return "f";
  const { data } = await forFamily(familyId)
    .select("tutor_voices", "gender")
    .eq("id", profile.tutor_voice_id)
    .maybeSingle<{ gender: TutorGender }>();
  return data?.gender ?? "f";
}
