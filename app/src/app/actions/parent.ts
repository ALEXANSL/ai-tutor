"use server";

import { revalidatePath } from "next/cache";
import { uk } from "@/i18n/uk";
import { pinSaveErrorMessage } from "@/lib/pin-errors";
import { requireParentAccess, requireParentAccount } from "@/server/auth/guards";
import { setParentPin } from "@/server/auth/parent-mode";
import { forFamily } from "@/server/db/family-scope";
import { getServerSecret } from "@/server/env";
import { TELEGRAM_NOT_CONFIGURED_MESSAGE, TEST_NOTIFICATION_NOT_CONFIGURED_MESSAGE } from "@/lib/urgent-channel-messages";
import { kickJobs } from "@/server/jobs/kick";
import { sendTestUrgentNotification } from "@/server/notify/urgent";
import { createLinkCode, getLinkedChatId, getTelegramBotUsername, unlinkChatId } from "@/server/notify/telegram";
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
  if (!result.ok) return { status: "error", message: pinSaveErrorMessage(result.error) };
  revalidatePath("/parent", "layout");
  return { status: "ok", message: uk.parent.settings.pinSaved };
}

/** US-11.7 КП-1: a one-time code (10 min) the parent opens as `t.me/<bot>?start=<code>`. */
export async function createTelegramLinkAction(): Promise<{ status: "ok"; url: string } | { status: "error"; message: string }> {
  const { familyId } = await requireParentAccess();
  const botUsername = await getTelegramBotUsername();
  if (!getServerSecret("TELEGRAM_BOT_TOKEN") || !botUsername) {
    return { status: "error", message: TELEGRAM_NOT_CONFIGURED_MESSAGE };
  }
  const code = await createLinkCode(familyId);
  return { status: "ok", url: `https://t.me/${botUsername}?start=${code}` };
}

export async function unlinkTelegramAction(): Promise<void> {
  const { familyId } = await requireParentAccess();
  await unlinkChatId(familyId);
  revalidatePath("/parent/settings");
}

/** US-11.7 КП-5: "Надіслати тестове термінове сповіщення" — e-mail + Telegram, marked "ТЕСТ". */
export async function sendTestUrgentNotificationAction(): Promise<{ status: "ok" | "error"; message: string }> {
  const { familyId } = await requireParentAccess();
  const emailConfigured = getServerSecret("RESEND_API_KEY") && getServerSecret("ALERT_EMAIL_TO");
  const telegramConfigured = getServerSecret("TELEGRAM_BOT_TOKEN") && (await getLinkedChatId(familyId));
  if (!emailConfigured && !telegramConfigured) {
    return { status: "error", message: TEST_NOTIFICATION_NOT_CONFIGURED_MESSAGE };
  }
  await sendTestUrgentNotification(familyId);
  kickJobs();
  return { status: "ok", message: uk.parent.settings.telegram.testSent };
}
