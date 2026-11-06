import "server-only";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError } from "@/server/ai/types";

/** Never expose provider response bodies or database errors to the child. */
export class ExplanationUnavailableError extends Error {
  constructor(cause: unknown) {
    let code = "EXPLAIN-UNKNOWN";
    let message = "Пояснення зараз недоступне. Спробуй ще раз або покажи це повідомлення тату.";
    if (cause instanceof BudgetBlockedError) {
      code = cause.reason === "hard_stop" ? "EXPLAIN-BUDGET" : "EXPLAIN-DEFERRED";
      message = "Пояснення призупинено через ліміт витрат на ШІ. Попроси тата перевірити «Бюджет і моделі».";
    } else if (cause instanceof AiNotConfiguredError) {
      code = "EXPLAIN-CONFIG";
      message = "Сервіс пояснень потребує налаштування. Попроси тата перевірити «Бюджет і моделі».";
    } else if (cause instanceof ProviderError) {
      code = cause.status === null ? "EXPLAIN-CONNECTION" : `EXPLAIN-HTTP-${cause.status}`;
      if (cause.status === 401 || cause.status === 403 || cause.status === 400 || cause.status === 404) {
        message = "Сервіс ШІ відхилив запит пояснення. Попроси тата перевірити доступ і налаштування моделі.";
      } else {
        message = "Сервіс ШІ не встиг відповісти або тимчасово недоступний. Спробуй ще раз.";
      }
    }
    super(`${message} Код: ${code}.`);
    this.name = "ExplanationUnavailableError";
    // Deliberately omit cause.message: it may contain provider payloads.
    console.error("lesson_explanation_failed", {
      code,
      ...(cause instanceof ProviderError ? { provider: cause.provider, status: cause.status } : {}),
    });
  }
}

export function explanationErrorMessage(error: unknown): string {
  return (error instanceof ExplanationUnavailableError ? error : new ExplanationUnavailableError(error)).message;
}
