import "server-only";
import type { TutorGender } from "@/i18n/uk";
import { resolveTutorGender } from "@/lib/persona/gender";
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

/**
 * Grammatical gender: the chosen voice's gender (PM-21, S12) or, while no
 * voice is chosen, the gender stored with the name choice (BUG-002).
 */
export async function getTutorGender(
  familyId: string,
  profile: Pick<ChildProfileRow, "tutor_voice_id" | "tutor_name_gender">,
): Promise<TutorGender> {
  let voiceGender: TutorGender | null = null;
  if (profile.tutor_voice_id) {
    const { data } = await forFamily(familyId)
      .select("tutor_voices", "gender")
      .eq("id", profile.tutor_voice_id)
      .maybeSingle<{ gender: TutorGender }>();
    voiceGender = data?.gender ?? null;
  }
  return resolveTutorGender({ voiceGender, nameGender: profile.tutor_name_gender });
}
