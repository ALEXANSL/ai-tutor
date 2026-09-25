"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { changeNickname, changeTutorName, completeOnboarding } from "@/server/persona/service";
import type { FormState } from "./state";

function tutorNameMessage(error: string): string {
  if (error === "not_suggested") return uk.validation.notSuggested;
  if (error === "not_allowed") return uk.child.myTutor.readOnly;
  return uk.validation.tutorName[error as keyof typeof uk.validation.tutorName] ?? uk.common.error;
}

export async function saveNicknameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, profile } = await requireChild({ allowOnboarding: true });
  const result = await changeNickname(ctx.familyId, String(formData.get("nickname") ?? ""), "child", profile.id);
  if (!result.ok) return { status: "error", message: uk.validation.nickname[result.error] };
  revalidatePath("/", "layout");
  if (!profile.onboarding_completed_at) redirect("/onboarding");
  return { status: "ok", message: uk.child.myTutor.saved };
}

export async function saveTutorNameAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, profile } = await requireChild({ allowOnboarding: true });
  const firstTime = !profile.onboarding_completed_at;
  const result = await changeTutorName(
    ctx.familyId,
    {
      choice: String(formData.get("choice") ?? ""),
      custom: String(formData.get("custom") ?? ""),
      gender: String(formData.get("gender") ?? ""),
    },
    "child",
    { profileId: profile.id, firstTime },
  );
  if (!result.ok) return { status: "error", message: tutorNameMessage(result.error) };
  revalidatePath("/", "layout");
  if (firstTime) redirect("/onboarding");
  return { status: "ok", message: uk.child.myTutor.saved };
}

export async function completeOnboardingAction(): Promise<void> {
  const { ctx, profile } = await requireChild({ allowOnboarding: true });
  await completeOnboarding(ctx.familyId, profile.id);
  revalidatePath("/", "layout");
  redirect("/today");
}
