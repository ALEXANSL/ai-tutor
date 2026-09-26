import "server-only";
import { getServerSecret } from "@/server/env";

/**
 * Resend (ADR-010): free tier, no custom domain — delivers only to the
 * account owner's own address, which is exactly `ALERT_EMAIL_TO` (D-38).
 */
export function isEmailConfigured(): boolean {
  return Boolean(getServerSecret("RESEND_API_KEY") && getServerSecret("ALERT_EMAIL_TO"));
}

export interface EmailDeliveryError {
  status: number | null;
  message: string;
}

export async function sendUrgentEmail(
  subject: string,
  bodyText: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: EmailDeliveryError }> {
  const key = getServerSecret("RESEND_API_KEY");
  const to = getServerSecret("ALERT_EMAIL_TO");
  const from = getServerSecret("ALERT_EMAIL_FROM") ?? "onboarding@resend.dev";
  if (!key || !to) {
    return { ok: false, error: { status: null, message: "RESEND_API_KEY / ALERT_EMAIL_TO не налаштовано" } };
  }
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to: [to], subject, text: bodyText }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: { status: res.status, message: body.slice(0, 300) || `resend error ${res.status}` } };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { status: null, message: (e as Error).message } };
  }
}
