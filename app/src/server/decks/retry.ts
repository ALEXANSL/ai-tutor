import { AiNotConfiguredError, BudgetBlockedError, ProviderError } from "@/server/ai/types";
import { DriveError } from "@/server/drive/google";

export function deckRetry(error: unknown, failures: number) {
  const message = error instanceof Error ? error.message : "";
  const delay = Math.min(1800, 30 * 2 ** Math.min(failures, 6));
  if (error instanceof BudgetBlockedError) return { seconds: 3600, reason: "Досягнуто ліміту бюджету ШІ. Система повторно перевірить ліміт." };
  if (error instanceof AiNotConfiguredError || (error instanceof ProviderError && [401, 403].includes(error.status ?? 0))) {
    return { seconds: 3600, reason: "Перевір налаштування доступу до ШІ. Система перевірить їх повторно." };
  }
  if (error instanceof ProviderError && (error.retryable || error.status === 429 || (error.status ?? 0) >= 500)) {
    return { seconds: delay, reason: "ШІ-сервіс тимчасово не завершив запит." };
  }
  if ((error instanceof DriveError && (error.code === "network" || error.status === 429 || (error.status ?? 0) >= 500)) ||
    /fetch failed|network|timed?\s*out|timeout|\((429|5\d\d)\)|Не вдалося (перевірити збережений|підготувати приватне|прочитати збережені|зберегти слайди)|Презентацію вже оновлено/i.test(message) ||
    error instanceof Error && ["TimeoutError","AbortError"].includes(error.name)) {
    return { seconds: delay, reason: "Тимчасовий збій зв’язку або сховища." };
  }
  return null;
}

export function legacyDeckRetry(message: string) {
  // The old voice helper collapsed budget, transient and configuration failures
  // into a single message. Re-enter once under the typed retry policy.
  return message === "Не вдалося озвучити слайд. Перевір голосовий сервіс і бюджет." ||
    message === "Не вдалося перевірити збережений аудіофрагмент." ||
    /(?:openai|anthropic|gemini).*(?:network|timeout|request did not complete|response incomplete|error (429|5\d\d))/i.test(message) ||
    !!deckRetry(new Error(message), 0);
}
