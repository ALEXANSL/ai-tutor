-- Read-only audit. Run in the project's Supabase SQL Editor as its owner.
-- No keys, chat contents, child names or raw provider errors are selected.
-- Results may include multiple families; keep this export private.
begin transaction read only;

-- Current routing (seed defaults do not prove these live values).
select family_id, role, primary_provider, primary_model,
       fallback_provider, fallback_model,
       escalation_provider, escalation_model,
       economy_provider, economy_model, params
from public.model_routes
order by family_id, role;

-- Actual recorded calls in the last 30 days; not provider billing totals.
select family_id, role, provider, model, status, fallback_used,
       count(*) as calls, sum(cost_usd) as recorded_cost_usd,
       round(avg(latency_ms)) as average_latency_ms,
       max(created_at) as last_call_at
from public.ai_calls
where created_at >= now() - interval '30 days'
group by family_id, role, provider, model, status, fallback_used
order by family_id, role, calls desc;

-- Candidates for unsupported runtime adapters in the audited code.
select family_id, role, primary_provider, fallback_provider,
       escalation_provider, economy_provider
from public.model_routes
where 'gemini' in (primary_provider, fallback_provider,
                  escalation_provider, economy_provider);

-- Models used in recorded calls without a price row.
select distinct c.provider, c.model
from public.ai_calls c
left join public.model_prices p on p.provider = c.provider and p.model = c.model
where c.created_at >= now() - interval '30 days' and p.provider is null;

rollback;
