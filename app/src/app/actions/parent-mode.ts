"use server";

import { redirect } from "next/navigation";
import { uk } from "@/i18n/uk";
import { requireUser } from "@/server/auth/guards";
import { clearParentMode, enterParentMode, touchParentMode } from "@/server/auth/parent-mode";
import type { FormState } from "./state";

export async function enterParentModeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireUser();
  if (ctx.role === "parent") redirect("/parent");
  const pin = String(formData.get("pin") ?? "");
  const result = await enterParentMode(ctx, pin);
  if (!result.ok) return { status: "error", message: uk.child.parentMode.errors[result.error] };
  redirect("/parent");
}

export async function exitParentModeAction(): Promise<void> {
  await clearParentMode();
  redirect("/today");
}

/** Called by the child UI: leaving the cabinet by any route ends parent mode. */
export async function endParentModeSilentlyAction(): Promise<void> {
  await clearParentMode();
}

export async function touchParentModeAction(): Promise<boolean> {
  const ctx = await requireUser();
  return touchParentMode(ctx);
}
