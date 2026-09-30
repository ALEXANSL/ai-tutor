import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { loadBudgetDashboard } from "@/server/budget/queries";
import { PageTitle, Panel } from "../ui";

const money = (n: number) => `$${n.toFixed(2)}`;

const STATE_BADGE: Record<string, string> = {
  normal: "bg-p-success/15 text-p-success",
  warned: "bg-p-warn/15 text-p-warn",
  budget: "bg-p-danger/15 text-p-danger",
  hard_stop: "bg-p-danger/15 text-p-danger",
};

/**
 * Budget dashboard (ADR-035): our own recorded spend (`ai_calls` +
 * `spend_months`) — never a provider account balance, since no provider
 * exposes one via API (checked, see the ADR). "Бюджет і моделі" nav entry;
 * model routing itself (S15) is a separate, not-yet-built slice.
 */
export default async function BudgetPage() {
  const { familyId } = await requireParentAccess();
  const data = await loadBudgetDashboard(familyId);
  const t = uk.parent.budget;
  const { forecast } = data;
  const trackPct = Math.min(forecast.pctOfLimit, 110);
  const maxDaily = Math.max(0, ...data.dailyTrend.map((p) => p.costUsd));
  const topSessions = data.sessions.slice(0, 15);

  return (
    <>
      <PageTitle>{t.title}</PageTitle>

      <Panel title={t.monthPanelTitle}>
        <p className="mb-3 text-[13px] text-p-muted">{t.monthPanelDesc}</p>
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <span className="text-[26px] font-extrabold">{t.spentOf(money(forecast.spentUsd), money(forecast.limitUsd))}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${STATE_BADGE[data.state]}`}>{t.states[data.state]}</span>
        </div>
        <div className="relative mb-1 h-4 overflow-hidden rounded-full bg-p-bg">
          <div
            className="h-full rounded-full bg-[linear-gradient(90deg,var(--p-success),var(--p-warn))]"
            style={{ width: `${Math.min(trackPct, 100)}%` }}
          />
          {forecast.pctOfLimit >= 100 && (
            <div className="absolute inset-y-0 right-0 bg-p-danger" style={{ width: `${Math.max(0, trackPct - 100)}%` }} />
          )}
        </div>
        <p className="mb-3 text-[11px] text-p-muted">{t.limitReserveHint(money(forecast.limitUsd * 1.1))}</p>
        <div className="rounded-xl bg-p-bg px-3.5 py-3 text-[13px]">
          <b>{t.forecastLabel}: </b>
          {money(forecast.forecastUsd)} <span className="text-p-muted">({t.forecastHint(Math.round(forecast.pctForecastOfLimit))})</span>
        </div>
        {data.safetyOverLimitUsd > 0 && (
          <p className="mt-2.5 text-[12px] text-p-muted">{t.safetyOverLimit(money(data.safetyOverLimitUsd))}</p>
        )}
      </Panel>

      <div className="grid gap-4 min-[820px]:grid-cols-2">
        <Panel title={t.byRoleTitle}>
          <p className="mb-3 text-[12px] text-p-muted">{t.byRoleDesc}</p>
          {data.byRole.length === 0 ? (
            <p className="text-[13px] text-p-muted">{t.noCallsYet}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.byRole.map((r) => (
                <li key={r.key}>
                  <div className="mb-1 flex justify-between text-[13px]">
                    <span className="font-semibold">{r.label}</span>
                    <span>{money(r.costUsd)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-p-bg">
                    <div className="h-full rounded-full bg-p-primary" style={{ width: `${r.pctOfTotal}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t.byProviderTitle}>
          <p className="mb-3 text-[12px] text-p-muted">{t.byProviderDesc}</p>
          {data.byProvider.length === 0 ? (
            <p className="text-[13px] text-p-muted">{t.noCallsYet}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.byProvider.map((p) => (
                <li key={p.key}>
                  <div className="mb-1 flex justify-between text-[13px]">
                    <span className="font-semibold">{p.label}</span>
                    <span>{money(p.costUsd)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-p-bg">
                    <div className="h-full rounded-full bg-p-primary" style={{ width: `${p.pctOfTotal}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={t.trendTitle}>
        <p className="mb-3 text-[12px] text-p-muted">{t.trendDesc}</p>
        {data.dailyTrend.length === 0 ? (
          <p className="text-[13px] text-p-muted">{t.noCallsYet}</p>
        ) : (
          <div className="flex items-end gap-[3px]" style={{ height: 120 }}>
            {data.dailyTrend.map((p) => (
              <div
                key={p.day}
                className="flex h-full flex-1 flex-col items-center justify-end"
                title={`${p.day}: ${money(p.costUsd)}`}
              >
                <div
                  className="w-full min-h-[2px] rounded-t bg-p-primary"
                  style={{ height: `${maxDaily > 0 ? (p.costUsd / maxDaily) * 100 : 0}%` }}
                />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t.sessionsTitle}>
        <p className="mb-3 text-[12px] text-p-muted">{t.sessionsDesc}</p>
        {topSessions.length === 0 ? (
          <p className="text-[13px] text-p-muted">{t.noSessionsYet}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-p-muted">
                  <th className="pb-2 pr-2">{t.sessionsTable.topic}</th>
                  <th className="pb-2 pr-2">{t.sessionsTable.started}</th>
                  <th className="pb-2 pr-2 text-right">{t.sessionsTable.cost}</th>
                  <th className="pb-2 text-right">{t.sessionsTable.calls}</th>
                </tr>
              </thead>
              <tbody>
                {topSessions.map((s) => (
                  <tr key={s.sessionId} className="border-t border-p-line">
                    <td className="py-2 pr-2 font-semibold">{s.topicTitle}</td>
                    <td className="py-2 pr-2 text-p-muted">
                      {new Intl.DateTimeFormat("uk-UA", { timeZone: data.timeZone, day: "numeric", month: "short" }).format(new Date(s.startedAt))}
                    </td>
                    <td className="py-2 pr-2 text-right font-bold">{money(s.costUsd)}</td>
                    <td className="py-2 text-right text-p-muted">{s.callCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t.errorsTitle}>
        <p className="mb-3 text-[12px] text-p-muted">{t.errorsDesc}</p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5">
          <div className="rounded-xl bg-p-bg px-3.5 py-3">
            <div className="text-[11px] uppercase text-p-muted">{t.totalCallsLabel}</div>
            <div className="text-lg font-extrabold">{data.errors.totalCalls}</div>
          </div>
          <div className="rounded-xl bg-p-bg px-3.5 py-3">
            <div className="text-[11px] uppercase text-p-muted">{t.errorsLabel}</div>
            <div className="text-lg font-extrabold">{data.errors.errorCount}</div>
          </div>
          <div className="rounded-xl bg-p-bg px-3.5 py-3">
            <div className="text-[11px] uppercase text-p-muted">{t.fallbackLabel}</div>
            <div className="text-lg font-extrabold">{data.errors.fallbackCount}</div>
          </div>
        </div>
      </Panel>
    </>
  );
}
