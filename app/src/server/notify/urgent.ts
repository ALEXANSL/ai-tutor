import "server-only";
import type { SafetyCategory } from "@/server/safety/classify";
import type { ModerationMode } from "@/server/safety/moderate";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { createServiceClient } from "@/server/supabase/clients";
import { enqueueJob } from "@/server/jobs/runner";
import { notifyParent } from "@/server/notifications";
import { getServerSecret } from "@/server/env";

/**
 * Urgent external delivery (ADR-010, US-11.7): builds the minimal message
 * (no quote, no nickname, no name/e-mail — КП-2), enqueues one delivery job
 * per channel so a Resend outage never blocks Telegram or vice versa (КП-3),
 * and schedules the one-time 10-minute reminder (Should, PM-14, КП-7).
 */
const CATEGORY_LABELS_UK: Record<SafetyCategory | "test", string> = {
  none: "—",
  fear: "страх",
  sadness: "смуток",
  self_harm: "самоушкодження",
  dangerous_act: "небезпечна дія",
  violence: "насильство",
  stranger_contact: "контакт з незнайомцем",
  secret_from_parent: "прохання про секрет",
  personal_data: "особисті дані",
  reward_request: "прохання про нагороду",
  jailbreak: "спроба обійти правила",
  inappropriate_name: "недоречне ім'я репетитора",
  other: "інше",
  test: "ТЕСТ",
};
const MODE_LABELS_UK: Record<ModerationMode, string> = {
  lesson: "урок",
  tutor_chat: "чат теми",
  friend_chat: "ШІ-друг",
  voice: "голосова розмова",
  tutor_name: "ім'я репетитора",
};

function cabinetUrl(): string {
  const base = getServerSecret("APP_BASE_URL") ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return base ? `${base.replace(/\/+$/, "")}/parent/notifications` : "кабінет застосунку";
}

export function buildUrgentMessage(
  category: SafetyCategory | "test",
  mode: ModerationMode,
  at: Date,
  isTest: boolean,
  timeZone: string,
): string {
  const time = at.toLocaleString("uk-UA", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const prefix = isTest ? "ШІ-Репетитор: ТЕСТ термінового сповіщення" : "ШІ-Репетитор: ТЕРМІНОВО";
  const category_ = CATEGORY_LABELS_UK[category] ?? category;
  return `${prefix} — ${category_}. ${time}, ${MODE_LABELS_UK[mode]}. Відкрийте кабінет: ${cabinetUrl()}`;
}

export const JOB_DELIVER = "notify.deliver_urgent";
export const JOB_REMIND = "notify.remind_unread";

export async function enqueueUrgentDelivery(
  familyId: string,
  safetyEventId: string | null,
  mode: ModerationMode,
  category: SafetyCategory | "test",
  isTest = false,
): Promise<void> {
  const db = createServiceClient();
  const rows: { id: string; channel: "email" | "telegram" }[] = [];
  for (const channel of ["email", "telegram"] as const) {
    const { data, error } = await db
      .from("outbound_deliveries")
      .insert({ family_id: familyId, safety_event_id: safetyEventId, channel, is_test: isTest })
      .select("id")
      .single<{ id: string }>();
    if (error || !data) throw new Error(`outbound_deliveries insert (${channel}) failed: ${error?.message}`);
    rows.push({ id: data.id, channel });
  }
  const timeZone = await getFamilyTimezone(forFamily(familyId));
  const message = buildUrgentMessage(category, mode, new Date(), isTest, timeZone);
  for (const row of rows) {
    await enqueueJob(
      familyId,
      JOB_DELIVER,
      { deliveryId: row.id, channel: row.channel, message },
      { dedupeKey: `notify:${row.id}`, maxAttempts: 3 },
    );
  }
  if (safetyEventId && !isTest) {
    await enqueueJob(
      familyId,
      JOB_REMIND,
      { safetyEventId, mode, category, message },
      { dedupeKey: `notify:remind:${safetyEventId}`, runAfter: new Date(Date.now() + 10 * 60_000) },
    );
  }
}

/** Parent cabinet "Надіслати тестове термінове сповіщення" (US-11.7 КП-5). */
export async function sendTestUrgentNotification(familyId: string): Promise<void> {
  await notifyParent(familyId, { type: "safety_alert", severity: "urgent", payload: { category: "test", mode: "lesson", isTest: true } }).catch(
    (e: Error) => console.error(`test safety_alert notification failed: ${e.message}`),
  );
  await enqueueUrgentDelivery(familyId, null, "lesson", "test", true);
}
