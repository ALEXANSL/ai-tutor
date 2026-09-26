"use server";

import { redirect } from "next/navigation";
import { uk } from "@/i18n/uk";
import { requireUser } from "@/server/auth/guards";
import { clearParentMode, enterParentMode, expireParentModeSilently, touchParentMode } from "@/server/auth/parent-mode";
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

/**
 * Called by the child UI: rendering a child screen ends parent mode on this
 * device (see `ParentModeAutoExit`). BUG-027: this softens the resulting
 * state to `"expired"` (a friendly `/today` redirect) rather than `"none"`
 * (the harsh `/denied` screen) — see `expireParentModeSilently` for why.
 */
export async function endParentModeSilentlyAction(): Promise<void> {
  await expireParentModeSilently();
}

export async function touchParentModeAction(): Promise<boolean> {
  const ctx = await requireUser();
  return touchParentMode(ctx);
}
