-- =============================================================================
-- S27 (ADR-023, D-76/D-77, D-89 — PO accepted the architect's defaults for
-- every open question in the ADR): background lesson-library warm-up.
--
-- 1. `lesson_sessions.mode` grows `'warming'` (a session that started "cold",
--    with zero active blocks for its topic, and is waiting on a
--    `library.warm_topic` job instead of blocking the request) and a new
--    `warm_job_id` column pointing at that job.
-- 2. `ai_calls.job_id` (nullable): tags a call as made from a background job
--    — today only ever `library.warm_topic` — so its cost can be summed
--    separately from the family's regular monthly spend (the daily warm-up
--    budget, `LIBRARY_WARM_DAILY_BUDGET_USD`, ADR-023 §Частина 1.6).
--    `record_ai_call` is redefined (not just altered) to also store it.
-- 3. `get_library_warm_daily_spend`: today's total `ai_calls.cost_usd` with
--    `job_id is not null`, in the family's own timezone — mirrors
--    `current_month`'s "family-local day" idiom.
-- 4. New `model_routes` role `step_reinforcement` (D-74/US-6.15, docs/02
--    7.3) — scaffolding only, per the architect's request: the row and its
--    routing exist, but nothing calls this role yet (a future slice,
--    US-6.15/S27's own remediation work, wires the call itself).
--
-- `jobs.type` and `jobs.dedupe_key` need NO new migration: both are already
-- free-form `text` (regex-checked, not an enum — S1's
-- `20260926100000_s1_ai_router_costs_jobs.sql`), so `'library.warm_topic'`
-- and `'library.warm:<topic_id>'` need no schema change (unlike BUG-023's
-- `pause_reason`/`mode`, which ARE closed enums and do need one below).
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- drop+add for the one check constraint that needs a new value / ON
-- CONFLICT DO NOTHING everywhere).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. `lesson_sessions.mode` + `warm_job_id` (ADR-023 §Частина 1.2/1.7).
-- ---------------------------------------------------------------------------
alter table public.lesson_sessions drop constraint if exists lesson_sessions_mode_check;
alter table public.lesson_sessions
  add constraint lesson_sessions_mode_check
  check (mode in ('choosing', 'warming', 'diagnostic', 'lesson', 'practice', 'review', 'friend', 'break', 'paused', 'summary'));

alter table public.lesson_sessions
  add column if not exists warm_job_id uuid references public.jobs (id) on delete set null;

comment on column public.lesson_sessions.mode is
  'choosing/warming precede the lesson: warming = topic had zero active blocks at start, waiting on a library.warm_topic job (ADR-023) instead of blocking the request.';
comment on column public.lesson_sessions.warm_job_id is
  'ADR-023: the library.warm_topic job this "cold-start" session is waiting on, while mode = ''warming''. Never set otherwise.';

-- ---------------------------------------------------------------------------
-- 2. `ai_calls.job_id` (ADR-023 §Частина 1.5/1.6) + `record_ai_call` update.
-- ---------------------------------------------------------------------------
alter table public.ai_calls
  add column if not exists job_id uuid references public.jobs (id) on delete set null;
create index if not exists ai_calls_job_id_idx on public.ai_calls (job_id) where job_id is not null;
comment on column public.ai_calls.job_id is
  'ADR-023: set when this call was made from a background job (today: library.warm_topic only) — the daily warm-up budget sums cost_usd where this is not null.';

-- Re-defines `record_ai_call` (S1) to also store `job_id` from `p_call ->>
-- 'job_id'` — everything else is byte-for-byte the S1 body.
create or replace function public.record_ai_call(p_family_id uuid, p_call jsonb)
returns table (ai_call_id uuid, previous_state text, state text, spent_usd numeric, limit_usd numeric)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_month   text := app_private.current_month(p_family_id);
  v_limit   numeric;
  v_cost    numeric := greatest(coalesce((p_call ->> 'cost_usd')::numeric, 0), 0);
  v_prev    text;
  v_new     text;
  v_spent   numeric;
  v_id      uuid;
  v_safety  boolean := (p_call ->> 'role') = 'safety_moderator';
  v_rank    constant text[] := array['normal', 'warned', 'budget', 'hard_stop'];
begin
  select coalesce((select ps.monthly_limit_usd from public.parent_settings ps
                    where ps.family_id = p_family_id), 100) into v_limit;

  insert into public.spend_months as s (family_id, month, limit_usd)
  values (p_family_id, v_month, v_limit)
  on conflict (family_id, month) do update set limit_usd = excluded.limit_usd;

  select s.spent_usd into v_spent from public.spend_months s
   where s.family_id = p_family_id and s.month = v_month for update;
  v_prev := app_private.budget_state_for(v_spent, v_limit);

  insert into public.ai_calls (
    family_id, role, provider, model, status, input_tokens, output_tokens, cached_input_tokens,
    cost_usd, latency_ms, fallback_used, budget_state, ref_table, ref_id, session_id, job_id, error)
  values (
    p_family_id, p_call ->> 'role', p_call ->> 'provider', p_call ->> 'model',
    coalesce(p_call ->> 'status', 'ok'),
    coalesce((p_call ->> 'input_tokens')::integer, 0),
    coalesce((p_call ->> 'output_tokens')::integer, 0),
    coalesce((p_call ->> 'cached_input_tokens')::integer, 0),
    v_cost, (p_call ->> 'latency_ms')::integer,
    coalesce((p_call ->> 'fallback_used')::boolean, false), v_prev,
    p_call ->> 'ref_table', (p_call ->> 'ref_id')::uuid, (p_call ->> 'session_id')::uuid,
    (p_call ->> 'job_id')::uuid,
    left(p_call ->> 'error', 500))
  returning id into v_id;

  -- Safety moderation above the limit is tracked separately (NFR-SAFE-13).
  if v_safety and v_prev in ('budget', 'hard_stop') then
    update public.spend_months s set safety_over_limit_usd = s.safety_over_limit_usd + v_cost
     where s.family_id = p_family_id and s.month = v_month;
  else
    update public.spend_months s set spent_usd = s.spent_usd + v_cost
     where s.family_id = p_family_id and s.month = v_month
     returning s.spent_usd into v_spent;
  end if;

  v_new := app_private.budget_state_for(v_spent, v_limit);
  update public.spend_months s
     set state = v_new,
         state_changed_at = case when s.state is distinct from v_new then now() else s.state_changed_at end
   where s.family_id = p_family_id and s.month = v_month;

  if array_position(v_rank, v_new) > array_position(v_rank, v_prev) then
    insert into public.notifications (family_id, type, severity, payload)
    values (p_family_id, 'budget_state', case when v_new = 'hard_stop' then 'urgent' else 'normal' end,
            jsonb_build_object('state', v_new, 'spent_usd', round(v_spent, 2), 'limit_usd', v_limit));
  end if;

  return query select v_id, v_prev, v_new, v_spent, v_limit;
end;
$$;
revoke all on function public.record_ai_call(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_ai_call(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Daily warm-up spend (ADR-023 §Частина 1.6) — mirrors `current_month`'s
--    "family-local day" idiom: truncate `now()` to a day in the family's own
--    timezone, then convert that local midnight back to a timestamptz.
-- ---------------------------------------------------------------------------
create or replace function public.get_library_warm_daily_spend(p_family_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  with tz as (select coalesce((select f.timezone from public.families f where f.id = p_family_id), 'UTC') as tz),
       day_start as (
         select (date_trunc('day', now() at time zone tz.tz)) at time zone tz.tz as ts
           from tz
       )
  select coalesce(sum(ac.cost_usd), 0)
    from public.ai_calls ac, day_start
   where ac.family_id = p_family_id
     and ac.job_id is not null
     and ac.created_at >= day_start.ts
$$;
revoke all on function public.get_library_warm_daily_spend(uuid) from public, anon, authenticated;
grant execute on function public.get_library_warm_daily_spend(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. `step_reinforcement` model route — scaffolding only (docs/02 7.3): the
--    role exists and routes to Claude Sonnet 5 (escalating to Opus 5.5 on
--    request, same pattern as `answer_evaluation`/`tutor_chat`), but no code
--    calls `callStructured("step_reinforcement", ...)` yet — that is
--    US-6.15/S27's own remediation-step work, a separate, later change.
--    No `economy_provider`/fallback_provider` set here for the same reason
--    every other unconfirmed-model row in these migrations leaves them
--    unset: GPT-5.6 Terra / Gemini 3.8 Flash ids are not yet confirmed in
--    their consoles (docs/02 7.3's own caveat, repeated from S1/S3b/S5).
-- ---------------------------------------------------------------------------
create or replace function app_private.seed_s27_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, escalation_provider, escalation_model, params)
  values
    (p_family, 'step_reinforcement', 'anthropic', 'claude-sonnet-5', 'anthropic', 'claude-opus-5-5',
     '{"max_tokens": 4000, "timeout_ms": 30000}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_s27_model_routes(uuid) from public;

create or replace function app_private.families_seed_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.seed_default_model_routes(new.id);
  perform app_private.seed_s3_model_routes(new.id);
  perform app_private.seed_s1b_model_routes(new.id);
  perform app_private.seed_s3b_model_routes(new.id);
  perform app_private.seed_s4_model_routes(new.id);
  perform app_private.seed_s5_model_routes(new.id);
  perform app_private.seed_s27_model_routes(new.id);
  return new;
end;
$$;
-- Trigger already exists (same name, S1); no need to recreate it.

-- Existing families get the new role too.
select app_private.seed_s27_model_routes(f.id) from public.families f;
