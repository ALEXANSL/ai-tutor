-- ADR-033 (prompt caching): tracking gap fix.
--
-- `ai_calls.input_tokens` today silently folds in `cache_write_tokens`
-- (`router.ts` added `usage.cacheWriteTokens` into `input_tokens` before the
-- DB write) because there was nowhere else to put it. `cost_usd` has always
-- been correct (computed from the full `Usage` object before that fold), so
-- this migration changes nothing about billing — it only gives cache-write
-- tokens their own column so a later per-role token-usage read (e.g. the
-- budget dashboard) can tell a one-time cache write (billed at its own,
-- higher rate) apart from ordinary input tokens instead of the two being
-- indistinguishable in `input_tokens`.
--
-- `app/src/server/ai/router.ts` was updated in the same change to stop
-- folding `cacheWriteTokens` into `input_tokens` and pass it as its own
-- `cache_write_tokens` field instead — this migration's `record_ai_call`
-- update is what makes that field land in its own column.

alter table public.ai_calls
  add column if not exists cache_write_tokens integer not null default 0
    check (cache_write_tokens >= 0);

-- Same function as the S1 migration (20260926100000), with one line added:
-- `cache_write_tokens` is now read from `p_call` and stored in its own
-- column instead of being absent (and, before this change, silently baked
-- into `input_tokens` by the caller).
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
    cache_write_tokens, cost_usd, latency_ms, fallback_used, budget_state, ref_table, ref_id,
    session_id, error)
  values (
    p_family_id, p_call ->> 'role', p_call ->> 'provider', p_call ->> 'model',
    coalesce(p_call ->> 'status', 'ok'),
    coalesce((p_call ->> 'input_tokens')::integer, 0),
    coalesce((p_call ->> 'output_tokens')::integer, 0),
    coalesce((p_call ->> 'cached_input_tokens')::integer, 0),
    coalesce((p_call ->> 'cache_write_tokens')::integer, 0),
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

revoke all on function public.record_ai_call(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_ai_call(uuid, jsonb) to service_role;
