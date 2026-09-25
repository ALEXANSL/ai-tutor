import "server-only";
import { forFamily, type FamilyScope } from "./db/family-scope";
import type { PlannedNotification } from "./persona/plan";

/** Notification centre write (US-11.6). Cabinet only — never e-mail/Telegram (D-12). */
export async function notifyParent(
  scopeOrFamilyId: FamilyScope | string,
  notification: PlannedNotification,
): Promise<void> {
  const scope = typeof scopeOrFamilyId === "string" ? forFamily(scopeOrFamilyId) : scopeOrFamilyId;
  const { error } = await scope.insert("notifications", {
    type: notification.type,
    severity: notification.severity,
    payload: notification.payload,
  });
  if (error) throw new Error(`notifyParent failed: ${error.message}`);
}
