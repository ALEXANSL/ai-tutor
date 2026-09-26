import "server-only";
import { notifyParent } from "@/server/notifications";
import { registerJobHandler, type JobRow } from "@/server/jobs/runner";
import { createServiceClient } from "@/server/supabase/clients";
import { sendUrgentEmail } from "./email";
import { getLinkedChatId, sendTelegramMessage } from "./telegram";
import { JOB_DELIVER, JOB_REMIND } from "./urgent";

const CHANNEL_LABELS_UK: Record<"email" | "telegram", string> = { email: "e-mail", telegram: "Telegram" };

/** Registers the S4 background job handlers (ADR-010, US-11.7 КП-3, КП-7). Called from `ensureJobHandlers()`. */
export function registerNotifyJobs(): void {
  registerJobHandler(JOB_DELIVER, {
    async run(job: JobRow) {
      const { deliveryId, channel, message } = job.payload as { deliveryId: string; channel: "email" | "telegram"; message: string };
      const db = createServiceClient();
      let result: { ok: true } | { ok: false; error: string };
      if (channel === "email") {
        const r = await sendUrgentEmail("ШІ-Репетитор — термінове сповіщення", message);
        result = r.ok ? { ok: true } : { ok: false, error: r.error.message };
      } else {
        const chatId = await getLinkedChatId(job.family_id);
        if (!chatId) {
          result = { ok: false, error: "Telegram не прив'язано (немає chat_id) або TELEGRAM_BOT_TOKEN не налаштовано" };
        } else {
          const r = await sendTelegramMessage(chatId, message);
          result = r.ok ? { ok: true } : { ok: false, error: r.error.message };
        }
      }
      if (result.ok) {
        await db.from("outbound_deliveries").update({ status: "sent", sent_at: new Date().toISOString(), attempts: job.attempts }).eq("id", deliveryId);
        return;
      }
      await db.from("outbound_deliveries").update({ status: "failed", attempts: job.attempts, last_error: result.error.slice(0, 300) }).eq("id", deliveryId);
      throw new Error(result.error);
    },
    isRetryable: () => true,
    async onGiveUp(job: JobRow) {
      const { channel } = job.payload as { channel: "email" | "telegram" };
      await notifyParent(job.family_id, {
        type: "external_delivery_failed",
        severity: "urgent",
        payload: { channel: CHANNEL_LABELS_UK[channel] },
      }).catch((e: Error) => console.error(`external_delivery_failed notification failed: ${e.message}`));
    },
  });

  // US-11.7 КП-7 (Should, PM-14): one resend, only if still unread 10 min later.
  registerJobHandler(JOB_REMIND, {
    async run(job: JobRow) {
      const { safetyEventId, message } = job.payload as { safetyEventId: string; message: string };
      const db = createServiceClient();
      const { data: notif } = await db
        .from("notifications")
        .select("id, read_at")
        .eq("family_id", job.family_id)
        .eq("type", "safety_alert")
        .contains("payload", { eventId: safetyEventId })
        .maybeSingle<{ id: string; read_at: string | null }>();
      if (!notif || notif.read_at) return; // already seen in the cabinet — no resend needed.
      const chatId = await getLinkedChatId(job.family_id);
      await Promise.all([
        sendUrgentEmail("ШІ-Репетитор — термінове сповіщення (повтор)", message),
        chatId ? sendTelegramMessage(chatId, message) : Promise.resolve(),
      ]);
    },
    isRetryable: () => false,
  });
}
