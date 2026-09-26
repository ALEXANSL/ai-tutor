import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { notifyParent } from "@/server/notifications";
import { kickJobs } from "@/server/jobs/kick";
import { enqueueUrgentDelivery } from "@/server/notify/urgent";
import { isFlagged, isUrgent, type ModerationResult } from "./classify";
import type { ModerationMode } from "./moderate";

/**
 * Turns a moderation verdict into what US-12.1/US-11.6/US-11.7 promise: a
 * `safety_events` row (parent-only, the quote never leaves it), a cabinet
 * notification (always, for any flagged category), and — for `urgent` only —
 * the e-mail + Telegram delivery job (ADR-010).
 */
export async function recordSafetyEvent(
  familyId: string,
  childProfileId: string,
  mode: ModerationMode,
  quote: string,
  result: ModerationResult,
  refs: { sessionId?: string; chatId?: string } = {},
): Promise<{ flagged: boolean; urgent: boolean; eventId: string | null }> {
  if (!isFlagged(result)) {
    // Residual-risk fix (QA, S4): `result.layersUnavailable` means BOTH
    // moderation layers failed for this message, so "category: none" here is
    // a fail-open default, not a real verdict — this message was never
    // actually checked. `safety_events` can't hold it (its `severity` column
    // only allows 'normal'/'urgent', by design — there is no real category
    // to store), so we can't raise the usual e-mail/Telegram urgent delivery
    // either without a schema change; ADR-009's own fail-open choice (never
    // block the child's reply for a provider outage) stays as-is here too.
    // The minimal, non-schema-changing safeguard: tell the parent, in the
    // cabinet, as an urgent-looking item, that moderation itself was down
    // for this message, so a human checks the conversation. This never
    // delays or blocks the child's own reply (chat.ts/friendChat.ts/
    // orchestrator.ts already returned it by the time this resolves).
    if (result.layersUnavailable) {
      await notifyParent(forFamily(familyId), {
        type: "safety_moderation_unavailable",
        severity: "urgent",
        payload: { mode, ...refs },
      }).catch((e: Error) => console.error(`safety_moderation_unavailable notification failed: ${e.message}`));
    }
    return { flagged: false, urgent: false, eventId: null };
  }

  const scope = forFamily(familyId);
  const { data, error } = await scope.client
    .from("safety_events")
    .insert({
      family_id: familyId,
      child_profile_id: childProfileId,
      mode,
      session_id: refs.sessionId ?? null,
      chat_id: refs.chatId ?? null,
      category: result.category,
      severity: result.severity,
      quote: quote.slice(0, 2000),
      model_confidence: result.confidence,
      layer1_flagged: result.layer1Flagged,
      escalated: result.escalated,
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`recordSafetyEvent failed: ${error?.message}`);

  // Cabinet always (US-11.6 КП-1); urgent is highlighted there too (severity field).
  await notifyParent(scope, {
    type: "safety_alert",
    severity: result.severity as "normal" | "urgent",
    payload: { category: result.category, mode, eventId: data.id },
  }).catch((e: Error) => console.error(`safety_alert notification failed: ${e.message}`));

  if (isUrgent(result)) {
    await enqueueUrgentDelivery(familyId, data.id, mode, result.category).catch((e: Error) =>
      console.error(`enqueueUrgentDelivery failed: ${e.message}`),
    );
    kickJobs();
  }

  return { flagged: true, urgent: isUrgent(result), eventId: data.id };
}
