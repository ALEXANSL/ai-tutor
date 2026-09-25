"use server";

import { revalidatePath } from "next/cache";
import { uk } from "@/i18n/uk";
import { requireParentAccess, requireParentAccount } from "@/server/auth/guards";
import { setParentPin } from "@/server/auth/parent-mode";
import { forFamily } from "@/server/db/family-scope";
import { changeNickname, changeTutorName, setPersonaChildEditable } from "@/server/persona/service";
import type { FormState } from "./state";

export async function parentSaveNicknameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const result = await changeNickname(familyId, String(formData.get("nickname") ?? ""), "parent");
  if (!result.ok) return { status: "error", message: uk.validation.nickname[result.error] };
  revalidatePath("/parent", "layout");
  return { status: "ok", message: uk.parent.child.saved };
}

export async function parentSaveTutorNameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const result = await changeTutorName(
    familyId,
    {
      choice: String(formData.get("choice") ?? ""),
      custom: String(formData.get("custom") ?? ""),
      gender: String(formData.get("gender") ?? ""),
    },
    "parent",
  );
  if (!result.ok) {
    const message =
      result.error === "not_suggested" || result.error === "not_allowed"
        ? uk.validation.notSuggested
        : uk.validation.tutorName[result.error];
    return { status: "error", message };
  }
  revalidatePath("/parent", "layout");
  return { status: "ok", message: uk.parent.child.saved };
}

export async function parentSetPersonaEditableAction(formData: FormData): Promise<void> {
  const { familyId } = await requireParentAccess();
  await setPersonaChildEditable(familyId, formData.get("editable") === "on");
  revalidatePath("/parent/child");
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const { familyId } = await requireParentAccess();
  const { error } = await forFamily(familyId)
    .update("notifications", { read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) throw new Error(error.message);
  revalidatePath("/parent", "layout");
}

export async function setPinAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccount();
  const result = await setParentPin(familyId, String(formData.get("pin") ?? ""), String(formData.get("repeat") ?? ""));
  if (!result.ok) {
    const s = uk.parent.settings;
    const message = result.error === "mismatch" ? s.pinMismatch : result.error === "format" ? s.pinFormat : uk.common.error;
    return { status: "error", message };
  }
  revalidatePath("/parent", "layout");
  return { status: "ok", message: uk.parent.settings.pinSaved };
}
