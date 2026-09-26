import "server-only";

/**
 * Same reasoning as `pin-errors.ts` (BUG-005): these messages name the exact
 * env var to set, so they must never enter the shared `uk` dictionary that
 * client components import (`check:bundle` treats a secret variable's NAME,
 * not only its value, as a leak) — server-only module, read only from
 * server actions, whose own response text is the sole way this reaches the
 * browser.
 */
export const RESEND_NOT_CONFIGURED_MESSAGE =
  "E-mail не налаштовано: задайте RESEND_API_KEY і ALERT_EMAIL_TO у Vercel → Settings → Environment Variables (docs/03, 1.11) і зробіть Redeploy.";

export const TELEGRAM_NOT_CONFIGURED_MESSAGE =
  "Telegram-бот не налаштовано: задайте TELEGRAM_BOT_TOKEN у Vercel → Settings → Environment Variables (docs/03, 1.12) і зробіть Redeploy.";

export const TEST_NOTIFICATION_NOT_CONFIGURED_MESSAGE =
  "Ще не налаштовано жодного каналу — задайте RESEND_API_KEY/ALERT_EMAIL_TO (e-mail) або прив'яжіть Telegram (TELEGRAM_BOT_TOKEN) у Vercel → Settings → Environment Variables.";
