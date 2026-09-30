-- =============================================================================
-- ADR-035: budget/spend dashboard for the parent cabinet, built entirely on
-- our OWN recorded spend (`ai_calls` + `spend_months`) — no provider account
-- balance exists via any provider API (ADR-035 research).
--
-- Adds the one missing piece of representation ADR-012's 2026-09-27 note
-- already called out: a per-session ("per-lesson") cost view, so the parent
-- cabinet can flag an unusually expensive lesson. No new tables, no new
-- columns — just a read-only aggregation over data already collected.
--
-- Safe to re-run in the Supabase SQL Editor: CREATE OR REPLACE / IF NOT
-- EXISTS everywhere.
-- =============================================================================

-- session_costs: cost per lesson session, joined with enough context (topic /
-- subject title, timing, status) for a parent-readable "cost per lesson" row.
-- `security_invoker` makes the view respect the RLS of the underlying tables
-- for whichever role queries it directly (the app itself reads through the
-- server-only service-role client, which already bypasses RLS as every other
-- table here does — this is the same defensive parity as `ai_calls_select_parent`
-- etc., not required for the app to function).
create or replace view public.session_costs
  with (security_invoker = true) as
select
  ls.id               as session_id,
  ls.family_id,
  ls.topic_id,
  t.title             as topic_title,
  ls.subject_id,
  s.name_uk           as subject_name,
  ls.mode,
  ls.status,
  ls.started_at,
  ls.completed_at,
  coalesce(sum(ac.cost_usd), 0)::numeric(12, 6)         as cost_usd,
  count(ac.id)                                           as call_count,
  count(*) filter (where ac.status = 'error')            as error_count,
  count(*) filter (where ac.fallback_used)                as fallback_count
from public.lesson_sessions ls
join public.topics t on t.id = ls.topic_id
join public.subjects s on s.id = ls.subject_id
left join public.ai_calls ac on ac.session_id = ls.id
group by ls.id, ls.family_id, ls.topic_id, t.title, ls.subject_id, s.name_uk, ls.mode, ls.status, ls.started_at, ls.completed_at;

comment on view public.session_costs is
  'Cost per lesson session (ADR-012 note 2026-09-27, ADR-035): aggregates ai_calls by session_id. No new data, read-only representation.';

grant select on public.session_costs to authenticated;
revoke all on public.session_costs from anon;
