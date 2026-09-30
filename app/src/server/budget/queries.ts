import "server-only";
import { forFamily, getFamilyTimezone } from "../db/family-scope";
import {
  breakdownByProvider,
  breakdownByRole,
  dailyTrend,
  errorFallbackSummary,
  forecastMonthSpend,
  type BreakdownItem,
  type DailyPoint,
  type ErrorFallbackSummary,
  type ForecastResult,
  type SpendCallInput,
} from "./aggregate";
import { daysInMonth, familyDateParts, monthKey } from "./time";

export type BudgetState = "normal" | "warned" | "budget" | "hard_stop";

export interface SessionCostItem {
  sessionId: string;
  topicTitle: string;
  subjectName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  costUsd: number;
  callCount: number;
  errorCount: number;
  fallbackCount: number;
}

export interface BudgetDashboardData {
  month: string;
  timeZone: string;
  state: BudgetState;
  safetyOverLimitUsd: number;
  stateChangedAt: string | null;
  forecast: ForecastResult;
  byRole: BreakdownItem[];
  byProvider: BreakdownItem[];
  dailyTrend: DailyPoint[];
  sessions: SessionCostItem[];
  errors: ErrorFallbackSummary;
}

interface AiCallDbRow {
  role: string;
  provider: string;
  cost_usd: number | string;
  status: "ok" | "error";
  fallback_used: boolean;
  created_at: string;
}

interface SpendMonthDbRow {
  month: string;
  spent_usd: number | string;
  limit_usd: number | string;
  state: BudgetState;
  safety_over_limit_usd: number | string;
  state_changed_at: string | null;
}

interface ParentSettingsLimitRow {
  monthly_limit_usd: number | string;
}

interface SessionCostDbRow {
  session_id: string;
  topic_title: string;
  subject_name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  cost_usd: number | string;
  call_count: number;
  error_count: number;
  fallback_count: number;
}

/** Raw internal role → plain Ukrainian label the parent sees (no jargon, D-… jargon-removal fix). */
const ROLE_LABELS_UK: Record<string, string> = {
  embeddings: "Пошук у книгах",
  indexing_structure: "Обробка книг",
  ocr_page: "Розпізнавання сторінок",
  lesson_planning: "Планування уроку",
  lesson_generation: "Генерація уроків",
  lesson_review: "Перевірка якості уроків",
  passive_narration: "Озвучка",
  safety_moderator: "Модерація безпеки",
};

/** A role that arrives with a later slice and has no label yet still gets a readable fallback, not the raw code. */
function roleLabelUk(role: string): string {
  return ROLE_LABELS_UK[role] ?? `Інше (${role.replace(/_/g, " ")})`;
}

const PROVIDER_LABELS_UK: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
};

function providerLabelUk(provider: string): string {
  return PROVIDER_LABELS_UK[provider] ?? provider;
}

/**
 * Everything the budget dashboard page needs (ADR-035): current month spend
 * vs. limit with a forecast, breakdown by role/provider, per-lesson cost,
 * daily trend, error/fallback counter. Built entirely on `ai_calls` +
 * `spend_months` — no provider account balance exists via any provider API
 * (see the ADR's own research), so this reads only our own recorded spend.
 */
export async function loadBudgetDashboard(familyId: string): Promise<BudgetDashboardData> {
  const scope = forFamily(familyId);
  const timeZone = await getFamilyTimezone(scope);
  const now = new Date();
  const today = familyDateParts(now, timeZone);
  const month = monthKey(today);
  const totalDaysInMonth = daysInMonth(today);

  // Overshoot the UTC lower bound by a day either side of the family's local
  // month start so no timezone offset can cut off same-month rows; the exact
  // month membership is re-checked per row below, in the family's own timezone.
  const approxMonthStartUtc = new Date(Date.UTC(today.year, today.month - 1, 1) - 24 * 3600 * 1000).toISOString();

  const [spendMonthRes, settingsRes, callsRes, sessionsRes] = await Promise.all([
    scope.select("spend_months", "month, spent_usd, limit_usd, state, safety_over_limit_usd, state_changed_at").eq("month", month).maybeSingle<SpendMonthDbRow>(),
    scope.select("parent_settings", "monthly_limit_usd").maybeSingle<ParentSettingsLimitRow>(),
    scope
      .select("ai_calls", "role, provider, cost_usd, status, fallback_used, created_at")
      .gte("created_at", approxMonthStartUtc)
      .order("created_at", { ascending: true })
      .returns<AiCallDbRow[]>(),
    scope
      .select("session_costs", "session_id, topic_title, subject_name, status, started_at, completed_at, cost_usd, call_count, error_count, fallback_count")
      .gte("started_at", approxMonthStartUtc)
      .returns<SessionCostDbRow[]>(),
  ]);

  const limitUsd = Number(spendMonthRes.data?.limit_usd ?? settingsRes.data?.monthly_limit_usd ?? 100);
  const spentUsd = Number(spendMonthRes.data?.spent_usd ?? 0);
  const state = spendMonthRes.data?.state ?? "normal";
  const safetyOverLimitUsd = Number(spendMonthRes.data?.safety_over_limit_usd ?? 0);
  const stateChangedAt = spendMonthRes.data?.state_changed_at ?? null;

  const calls: SpendCallInput[] = (callsRes.data ?? [])
    .map((r) => ({ ...r, parts: familyDateParts(new Date(r.created_at), timeZone) }))
    .filter((r) => monthKey(r.parts) === month)
    .map((r) => ({
      role: r.role,
      provider: r.provider,
      costUsd: Number(r.cost_usd),
      status: r.status,
      fallbackUsed: r.fallback_used,
      day: r.parts.day,
    }));

  const sessions: SessionCostItem[] = (sessionsRes.data ?? [])
    .filter((r) => monthKey(familyDateParts(new Date(r.started_at), timeZone)) === month)
    .map((r) => ({
      sessionId: r.session_id,
      topicTitle: r.topic_title,
      subjectName: r.subject_name,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      costUsd: Number(r.cost_usd),
      callCount: r.call_count,
      errorCount: r.error_count,
      fallbackCount: r.fallback_count,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    month,
    timeZone,
    state,
    safetyOverLimitUsd,
    stateChangedAt,
    forecast: forecastMonthSpend({ spentUsd, limitUsd, daysElapsed: today.day, daysInMonth: totalDaysInMonth }),
    byRole: breakdownByRole(calls, roleLabelUk),
    byProvider: breakdownByProvider(calls, providerLabelUk),
    dailyTrend: dailyTrend(calls, today.day),
    sessions,
    errors: errorFallbackSummary(calls),
  };
}
