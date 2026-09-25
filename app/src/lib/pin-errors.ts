import "server-only";
import { uk } from "@/i18n/uk";
import type { SetPinError } from "@/server/auth/parent-mode";

/**
 * BUG-005: setting the PIN must not collapse "server not configured" and
 * "you typed it wrong" into the same generic error — the parent needs a
 * concrete, actionable message for the former.
 *
 * The env var NAME below is server-only on purpose (`import "server-only"`,
 * never added to the shared `uk` dictionary that client components import):
 * `check:bundle` treats a secret variable's NAME, not only its value, as a
 * leak, so this string must never reach a statically-bundled client chunk.
 * It only ever reaches the browser as this one server action's own response.
 */
const PIN_UNAVAILABLE_MESSAGE =
  "Сервер не налаштовано: змінна PIN_PEPPER відсутня або коротша за 16 символів. " +
  "Задайте її у Vercel → Settings → Environment Variables (довгий випадковий рядок, ≥ 16 символів) і зробіть Redeploy — див. app/README.md.";

export function pinSaveErrorMessage(error: SetPinError): string {
  const s = uk.parent.settings;
  if (error === "mismatch") return s.pinMismatch;
  if (error === "format") return s.pinFormat;
  return PIN_UNAVAILABLE_MESSAGE;
}
