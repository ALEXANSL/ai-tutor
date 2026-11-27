import "server-only";
import { forFamily } from "@/server/db/family-scope";

/** Plain reasons for an image service refusal. Only the HTTP code is read from the log; raw provider text never reaches the page. */
const REASONS: Record<number, string> = {
  400: "сервіс відхилив запит або його параметри",
  401: "API-ключ не прийнято",
  403: "немає доступу до моделі зображень (ключ, верифікація організації або білінг)",
  404: "модель зображень недоступна цьому обліковому запису",
  429: "ліміт запитів або не вистачає коштів на рахунку сервісу",
};
export interface IllustrationFailure { provider: string; model: string; code?: number; reason: string; count: number; }

/** Known provider explanations, recognised by keyword so the provider's own text is never shown. */
const HINTS: [RegExp, string][] = [
  [/verif/i, "організацію в OpenAI треба верифікувати (Settings → Organization → Verify)"],
  [/billing|quota|insufficient|credit|payment/i, "у сервісу закінчились кошти або не підключено білінг"],
  [/api key not valid|invalid.*key|incorrect api key|unauthenticated/i, "API-ключ недійсний"],
  [/not found|not supported|does not exist|unknown model/i, "назва моделі не підходить цьому акаунту"],
  [/location|region|country/i, "сервіс недоступний у регіоні сервера"],
  [/safety|blocked|moderation|policy/i, "сервіс заблокував опис картинки фільтром безпеки"],
];
export function illustrationFailureReason(error: string | null | undefined) {
  const hint = HINTS.find(([pattern]) => pattern.test(/\[provider: (.*)\]/.exec(error ?? "")?.[1] ?? ""))?.[1];
  const base = plainReason(error);
  return hint ? { ...base, reason: hint } : base;
}
function plainReason(error: string | null | undefined) {
  const code = Number(/\(HTTP (\d{3})\)/.exec(error ?? "")?.[1]) || undefined;
  return { code, reason: code ? REASONS[code] ?? (code >= 500 ? "сервіс тимчасово недоступний" : "сервіс відмовив") : /uncertain/.test(error ?? "") ? "сервіс не підтвердив результат" : "невідома помилка" };
}

/** Why the latest pictures of a deck failed, grouped by service. */
export async function loadIllustrationFailures(familyId: string, deckId: string): Promise<IllustrationFailure[]> {
  const { data, error } = await forFamily(familyId).select("ai_calls", "provider,model,status,error,created_at")
    .eq("role", "deck.illustration").eq("ref_id", deckId).order("created_at", { ascending: false }).limit(30)
    .returns<{ provider: string; model: string; status: string; error: string | null }[]>();
  if (error || !data?.length) return [];
  // Only the failures since the last successful picture describe the current state.
  const lastOk = data.findIndex(row => row.status === "ok");
  const recent = lastOk === -1 ? data : data.slice(0, lastOk);
  const groups = new Map<string, IllustrationFailure>();
  for (const row of recent) {
    const { code, reason } = illustrationFailureReason(row.error);
    const key = `${row.provider}|${row.model}|${code}`;
    const group = groups.get(key) ?? { provider: row.provider, model: row.model, code, reason, count: 0 };
    group.count++; groups.set(key, group);
  }
  return [...groups.values()];
}
