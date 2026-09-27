import "server-only";

/**
 * Same reasoning as `pin-errors.ts` / `urgent-channel-messages.ts` (BUG-005):
 * these messages name the exact env var to set, so they must never enter the
 * shared `uk` dictionary that client components import (`check:bundle`
 * treats a secret variable's NAME, not only its value, as a leak) — this
 * module is server-only, read only from the Settings page (a Server
 * Component), whose already-resolved HTML output is the sole way the text
 * reaches the browser.
 */
export const DRIVE_OAUTH_NOT_CONFIGURED_MESSAGE =
  "Google Drive ще не налаштовано на сервері: задайте GOOGLE_OAUTH_CLIENT_ID і GOOGLE_OAUTH_CLIENT_SECRET у Vercel → Settings → Environment Variables (docs/03, розд. 1.5А, крок 6) і зробіть Redeploy.";

export const DRIVE_UPLOADS_FOLDER_PASTE_HINT =
  "Останній крок (одноразово): скопіюйте ID нижче в змінну середовища GOOGLE_DRIVE_UPLOADS_FOLDER_ID у Vercel → Settings → Environment Variables (docs/03, розд. 1.14) і зробіть Redeploy — після цього «Завантажити файл» одразу індексуватиме нові книги.";
