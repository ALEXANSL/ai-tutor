-- =============================================================================
-- S1 / AI access layer: model routing table, price list, per-call cost log,
-- monthly spend with budget state; background jobs table; integration status.
--
-- Requirements: NFR-COST-4, NFR-COST-8, US-13.1 (table, edited in S15),
-- US-11.5 KP-6 (indexing deferred in budget mode); ADR-004, ADR-005, ADR-012,
-- ADR-015, ADR-018 (family_id + RLS everywhere).
--
-- Safe to re-run in the Supabase SQL Editor: IF NOT EXISTS / OR REPLACE /
-- DROP ... IF EXISTS everywhere, seeds use ON CONFLICT DO NOTHING.
-- =============================================================================

-- Extensions (Supabase keeps them in the `extensions` schema). ------------------
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- Monthly AI limit lives with the other parent settings (docs/02 8.2). ----------
alter table public.parent_settings
  add column if not exists monthly_limit_usd numeric(10, 2) not null default 100
    check (monthly_limit_usd > 0);

-- Price list (reference data, not family data; docs/02 6.1). -------------------
-- Updated by hand when providers change prices (AR-R1) — no deploy needed.
create table if not exists public.model_prices (
  id                        uuid primary key default gen_random_uuid(),
  provider                  text not null check (provider ~ '^[a-z][a-z0-9_]*$'),
  model                     text not null,
  input_usd_per_mtok        numeric(12, 6) not null default 0,
  output_usd_per_mtok       numeric(12, 6) not null default 0,
  cache_read_usd_per_mtok   numeric(12, 6),
  cache_write_usd_per_mtok  numeric(12, 6),
  notes                     text,
  updated_at                timestamptz not null default now(),
  unique (provider, model)
);
comment on table public.model_prices is
  'USD prices per 1M tokens used to estimate ai_calls.cost_usd (ADR-012). Edit rows when prices change.';

-- Prices from docs/03-resources-and-costs.md 2.1 (checked 2026-09-25).
insert into public.model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, notes)
values
  ('anthropic', 'claude-opus-5-5', 4, 20, 0.20, 'docs/03 2.1'),
  ('anthropic', 'claude-sonnet-5', 2, 10, null, 'docs/03 2.1'),
  ('anthropic', 'claude-haiku-4-5', 1, 5, null, 'docs/03 2.1'),
  ('openai', 'text-embedding-3-large', 0.13, 0, null, 'docs/03 2.1')
on conflict (provider, model) do nothing;

-- Model routes: role -> model (docs/02 6.1). Edited only by the parent (S15). --
-- `role` is a string, not an enum: modules add roles without schema changes (ADR-017).
create table if not exists public.model_routes (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families (id) on delete cascade,
  role                 text not null check (role ~ '^[a-z][a-z0-9_.]*$'),
  primary_provider     text not null,
  primary_model        text not null,
  fallback_provider    text,
  fallback_model       text,
  escalation_provider  text,
  escalation_model     text,
  economy_provider     text,
  economy_model        text,
  -- max_tokens, timeout_ms, effort, dimensions, batch_size, budget_policy ('defer' | 'primary')
  params               jsonb not null default '{}'::jsonb,
  updated_by           uuid references public.app_users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (family_id, role),
  check ((fallback_provider is null) = (fallback_model is null)),
  check ((escalation_provider is null) = (escalation_model is null)),
  check ((economy_provider is null) = (economy_model is null))
);
create index if not exists model_routes_family_id_idx on public.model_routes (family_id);
drop trigger if exists model_routes_touch on public.model_routes;
create trigger model_routes_touch before update on public.model_routes
  for each row execute function app_private.touch_updated_at();

-- Default routes for S1 roles (docs/02 7.3, ADR-005). Other roles arrive with
-- their slices. The OpenAI fallback for indexing_structure (GPT-5.6 Sol) is
-- added once its exact API id is confirmed in the OpenAI console (docs/02 7.3).
create or replace function app_private.seed_default_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, params)
  values
    (p_family, 'embeddings', 'openai', 'text-embedding-3-large',
     '{"dimensions": 1536, "batch_size": 64, "timeout_ms": 60000, "budget_policy": "primary"}'::jsonb),
    (p_family, 'indexing_structure', 'anthropic', 'claude-opus-5-5',
     '{"max_tokens": 16000, "effort": "medium", "timeout_ms": 240000, "budget_policy": "defer"}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_default_model_routes(uuid) from public;

create or replace function app_private.families_seed_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.seed_default_model_routes(new.id);
  return new;
end;
$$;
drop trigger if exists families_seed_defaults on public.families;
create trigger families_seed_defaults after insert on public.families
  for each row execute function app_private.families_seed_defaults();

-- Existing families (S0 is already deployed).
select app_private.seed_default_model_routes(f.id) from public.families f;

-- Monthly spend (month in the family's time zone; ADR-012). -------------------
create table if not exists public.spend_months (
  family_id              uuid not null references public.families (id) on delete cascade,
  month                  text not null check (month ~ '^\d{4}-\d{2}$'),
  limit_usd              numeric(10, 2) not null,
  spent_usd              numeric(12, 6) not null default 0,
  safety_over_limit_usd  numeric(12, 6) not null default 0,
  state                  text not null default 'normal'
                           check (state in ('normal', 'warned', 'budget', 'hard_stop')),
  state_changed_at       timestamptz,
  created_at             timestamptz not null default now(),
  primary key (family_id, month)
);

-- Every AI call (NFR-COST-4). -----------------------------------------------
create table if not exists public.ai_calls (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families (id) on delete cascade,
  role                 text not null,
  provider             text not null,
  model                text not null,
  status               text not null default 'ok' check (status in ('ok', 'error')),
  input_tokens         integer not null default 0 check (input_tokens >= 0),
  output_tokens        integer not null default 0 check (output_tokens >= 0),
  cached_input_tokens  integer not null default 0 check (cached_input_tokens >= 0),
  cost_usd             numeric(12, 6) not null default 0 check (cost_usd >= 0),
  latency_ms           integer,
  fallback_used        boolean not null default false,
  budget_state         text,
  -- What the call was for, e.g. ('materials', <id>) — used for "indexing cost" of a book.
  ref_table            text,
  ref_id               uuid,
  session_id           uuid,
  error                text,
  created_at           timestamptz not null default now()
);
create index if not exists ai_calls_family_created_idx on public.ai_calls (family_id, created_at desc);
create index if not exists ai_calls_ref_idx on public.ai_calls (ref_table, ref_id);

create or replace function app_private.budget_state_for(p_spent numeric, p_limit numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_limit is null or p_limit <= 0 then 'normal'
    when p_spent >= p_limit * 1.10 then 'hard_stop'
    when p_spent >= p_limit then 'budget'
    when p_spent >= p_limit * 0.80 then 'warned'
    else 'normal'
  end
$$;

create or replace function app_private.current_month(p_family uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select to_char(now() at time zone coalesce(
    (select f.timezone from public.families f where f.id = p_family), 'UTC'), 'YYYY-MM')
$$;

-- Current budget state (router step 1, docs/02 6.2). Uses the CURRENT limit so a
-- raised limit takes effect immediately (ADR-012 "Відновлення").
create or replace function public.get_budget_state(p_family_id uuid)
returns table (month text, state text, spent_usd numeric, limit_usd numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select app_private.current_month(p_family_id) as month),
       lim as (select coalesce((select ps.monthly_limit_usd from public.parent_settings ps
                                 where ps.family_id = p_family_id), 100) as limit_usd),
       sp as (select coalesce((select s.spent_usd from public.spend_months s, m
                                where s.family_id = p_family_id and s.month = m.month), 0) as spent_usd)
  select m.month, app_private.budget_state_for(sp.spent_usd, lim.limit_usd), sp.spent_usd, lim.limit_usd
    from m, lim, sp
$$;

-- Records one call and increments the month in the SAME transaction (ADR-012,
-- NFR-COST-8). Returns the state before/after; a transition to a higher state
-- creates a notification for the parent.
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
    cost_usd, latency_ms, fallback_used, budget_state, ref_table, ref_id, session_id, error)
  values (
    p_family_id, p_call ->> 'role', p_call ->> 'provider', p_call ->> 'model',
    coalesce(p_call ->> 'status', 'ok'),
    coalesce((p_call ->> 'input_tokens')::integer, 0),
    coalesce((p_call ->> 'output_tokens')::integer, 0),
    coalesce((p_call ->> 'cached_input_tokens')::integer, 0),
    v_cost, (p_call ->> 'latency_ms')::integer,
    coalesce((p_call ->> 'fallback_used')::boolean, false), v_prev,
    p_call ->> 'ref_table', (p_call ->> 'ref_id')::uuid, (p_call ->> 'session_id')::uuid,
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

revoke all on function public.get_budget_state(uuid) from public, anon, authenticated;
revoke all on function public.record_ai_call(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.get_budget_state(uuid) to service_role;
grant execute on function public.record_ai_call(uuid, jsonb) to service_role;
revoke all on function app_private.budget_state_for(numeric, numeric) from public;
revoke all on function app_private.current_month(uuid) from public;

-- Background jobs (ADR-015). -------------------------------------------------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families (id) on delete cascade,
  type          text not null check (type ~ '^[a-z][a-z0-9_.]*$'),
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts      smallint not null default 0,
  max_attempts  smallint not null default 5 check (max_attempts between 1 and 20),
  run_after     timestamptz not null default now(),
  locked_until  timestamptz,
  last_error    text,
  dedupe_key    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists jobs_family_id_idx on public.jobs (family_id);
create index if not exists jobs_pending_idx on public.jobs (run_after) where status in ('queued', 'running');
-- One pending job per dedupe key (e.g. "ingest:<material>"), idempotent enqueue (NFR-RES-3).
create unique index if not exists jobs_dedupe_pending_idx
  on public.jobs (family_id, dedupe_key) where dedupe_key is not null and status in ('queued', 'running');
drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before update on public.jobs
  for each row execute function app_private.touch_updated_at();

-- Claims due jobs (also those whose lock expired after a crash).
create or replace function public.claim_jobs(p_limit integer, p_lock_seconds integer)
returns setof public.jobs
language sql
security definer
set search_path = ''
as $$
  update public.jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         locked_until = now() + make_interval(secs => p_lock_seconds)
   where j.id in (
     select q.id from public.jobs q
      where (q.status = 'queued' and q.run_after <= now())
         or (q.status = 'running' and q.locked_until < now())
      order by q.run_after
      limit p_limit
      for update skip locked)
  returning j.*
$$;
revoke all on function public.claim_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_jobs(integer, integer) to service_role;

-- Integration status (docs/02 8.2): e.g. whether the Drive folder is public. --
create table if not exists public.integration_status (
  family_id   uuid not null references public.families (id) on delete cascade,
  kind        text not null check (kind ~ '^[a-z][a-z0-9_.]*$'),
  status      jsonb not null default '{}'::jsonb,
  checked_at  timestamptz not null default now(),
  primary key (family_id, kind)
);

-- RLS: all of this is parent-only; writes go through the server (service role).
alter table public.model_prices enable row level security;
alter table public.model_routes enable row level security;
alter table public.spend_months enable row level security;
alter table public.ai_calls enable row level security;
alter table public.jobs enable row level security;
alter table public.integration_status enable row level security;

drop policy if exists model_prices_select_parent on public.model_prices;
create policy model_prices_select_parent on public.model_prices
  for select to authenticated
  using ((select public.app_role()) = 'parent');

drop policy if exists model_routes_select_parent on public.model_routes;
create policy model_routes_select_parent on public.model_routes
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

drop policy if exists spend_months_select_parent on public.spend_months;
create policy spend_months_select_parent on public.spend_months
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

drop policy if exists ai_calls_select_parent on public.ai_calls;
create policy ai_calls_select_parent on public.ai_calls
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

drop policy if exists jobs_select_parent on public.jobs;
create policy jobs_select_parent on public.jobs
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

drop policy if exists integration_status_select_parent on public.integration_status;
create policy integration_status_select_parent on public.integration_status
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

revoke all on public.model_prices, public.model_routes, public.spend_months, public.ai_calls,
  public.jobs, public.integration_status from anon;
revoke insert, update, delete, truncate on public.model_prices, public.model_routes,
  public.spend_months, public.ai_calls, public.jobs, public.integration_status from authenticated;
