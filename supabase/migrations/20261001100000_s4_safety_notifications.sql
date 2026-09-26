-- =============================================================================
-- S4 / Safety in conversation + "ШІ-друг" (text) + breaks + notification
-- centre + urgent e-mail/Telegram alerts.
--
-- Requirements: US-12.1, US-12.2, US-12.3, US-8.5, US-11.6, US-11.7,
-- US-1.7 KP-3/KP-10; NFR-SAFE-1…14, NFR-PRIV-10, NFR-PERF-11; docs/02 9.5,
-- ADR-009, ADR-010, ADR-012. Builds on S0…S3b.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- ON CONFLICT DO NOTHING / drop+add for the widened check constraint).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Breaks (US-12.2, налашт.): a per-child threshold, and per-session counters
-- so the parent's daily summary (US-11.1) can show missed breaks (S11 wires
-- the summary UI; the counters exist from S4 so nothing is lost meanwhile).
-- ---------------------------------------------------------------------------
alter table public.child_profile
  add column if not exists break_after_minutes smallint not null default 20 check (break_after_minutes between 5 and 60);

alter table public.lesson_sessions
  add column if not exists seconds_since_break integer not null default 0 check (seconds_since_break >= 0),
  add column if not exists breaks_offered smallint not null default 0 check (breaks_offered >= 0),
  add column if not exists breaks_taken smallint not null default 0 check (breaks_taken >= 0),
  add column if not exists breaks_skipped smallint not null default 0 check (breaks_skipped >= 0);

-- `pause_reason` grows one value, 'break' (US-12.2 KP-2: the child can take a
-- break at any moment, not only when offered — it pauses the session exactly
-- like an alarm or idle timeout, docs/02 5.3).
alter table public.lesson_sessions drop constraint if exists lesson_sessions_pause_reason_check;
alter table public.lesson_sessions
  add constraint lesson_sessions_pause_reason_check
  check (pause_reason in ('manual_alert', 'air_alert', 'idle', 'network', 'budget_hard', 'parent_mode', 'break'));

-- ---------------------------------------------------------------------------
-- Safety events (ADR-009): every "tривожна" reply the moderator flags, kept
-- for the parent only — the quote never leaves this table (US-11.7 KP-2: the
-- external e-mail/Telegram message never repeats it).
-- ---------------------------------------------------------------------------
create table if not exists public.safety_events (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families (id) on delete cascade,
  child_profile_id  uuid not null references public.child_profile (id) on delete cascade,
  mode              text not null check (mode in ('lesson', 'tutor_chat', 'friend_chat', 'voice', 'tutor_name')),
  session_id        uuid references public.lesson_sessions (id) on delete set null,
  chat_id           uuid references public.chats (id) on delete set null,
  category          text not null,
  severity          text not null check (severity in ('normal', 'urgent')),
  quote             text not null,
  model_confidence  numeric,
  layer1_flagged    boolean not null default false,
  escalated         boolean not null default false,
  created_at        timestamptz not null default now()
);
create index if not exists safety_events_family_idx on public.safety_events (family_id, created_at desc);
create index if not exists safety_events_urgent_idx on public.safety_events (family_id) where severity = 'urgent';
comment on column public.safety_events.quote is
  'Parent-only, never sent to e-mail/Telegram (NFR-PRIV-10, US-11.7 KP-2).';

-- ---------------------------------------------------------------------------
-- Urgent external delivery (ADR-010): one row per channel per attempt-cycle;
-- the retry job (`notify.deliver_urgent`) updates status in place.
-- ---------------------------------------------------------------------------
create table if not exists public.outbound_deliveries (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families (id) on delete cascade,
  safety_event_id   uuid references public.safety_events (id) on delete cascade,
  channel           text not null check (channel in ('email', 'telegram')),
  status            text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts          smallint not null default 0,
  last_error        text,
  is_test           boolean not null default false,
  reminded_at       timestamptz,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz
);
create index if not exists outbound_deliveries_family_idx on public.outbound_deliveries (family_id, created_at desc);
create index if not exists outbound_deliveries_event_idx on public.outbound_deliveries (safety_event_id);

-- ---------------------------------------------------------------------------
-- Telegram chat binding (ADR-010): one-time code -> chat id. The chat id is
-- stored encrypted with a key derived from TELEGRAM_BOT_TOKEN (a secret only
-- the server already holds for this very feature) via pgcrypto, so a DB dump
-- alone never reveals it (NFR-PRIV-10). This is the single-family MVP
-- reading of "environment variables or an encrypted secrets store" — see
-- `app/src/server/integrations.ts` and docs/STATUS.md for the note that a
-- multi-family SaaS would use Supabase Vault/a table instead.
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.telegram_link_codes (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  code        text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists telegram_link_codes_family_idx on public.telegram_link_codes (family_id);

alter table public.parent_settings
  add column if not exists telegram_chat_id_enc bytea,
  add column if not exists telegram_linked_at timestamptz;

-- SECURITY DEFINER RPCs: only the server (service_role) calls these, with the
-- bot token passed in as the passphrase (never stored) — same style as
-- `record_ai_call` (ADR-012).
create or replace function public.set_telegram_chat_id(p_family_id uuid, p_chat_id text, p_passphrase text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.parent_settings
     set telegram_chat_id_enc = extensions.pgp_sym_encrypt(p_chat_id, p_passphrase),
         telegram_linked_at = now()
   where family_id = p_family_id;
$$;
revoke all on function public.set_telegram_chat_id(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_telegram_chat_id(uuid, text, text) to service_role;

create or replace function public.get_telegram_chat_id(p_family_id uuid, p_passphrase text)
returns text
language sql
security definer
set search_path = ''
as $$
  select case when telegram_chat_id_enc is null then null
              else extensions.pgp_sym_decrypt(telegram_chat_id_enc, p_passphrase)
         end
    from public.parent_settings
   where family_id = p_family_id;
$$;
revoke all on function public.get_telegram_chat_id(uuid, text) from public, anon, authenticated;
grant execute on function public.get_telegram_chat_id(uuid, text) to service_role;

create or replace function public.clear_telegram_chat_id(p_family_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.parent_settings set telegram_chat_id_enc = null, telegram_linked_at = null
   where family_id = p_family_id;
$$;
revoke all on function public.clear_telegram_chat_id(uuid) from public, anon, authenticated;
grant execute on function public.clear_telegram_chat_id(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS (NFR-PRIV-4): parent-only reads; all writes go through service_role.
-- ---------------------------------------------------------------------------
alter table public.safety_events enable row level security;
alter table public.outbound_deliveries enable row level security;
alter table public.telegram_link_codes enable row level security;

drop policy if exists safety_events_select_parent on public.safety_events;
create policy safety_events_select_parent on public.safety_events
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

drop policy if exists outbound_deliveries_select_parent on public.outbound_deliveries;
create policy outbound_deliveries_select_parent on public.outbound_deliveries
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

-- Never selectable by any client role — a code in flight identifies nothing
-- about a child, but is still a family secret in transit.
revoke all on public.telegram_link_codes from anon, authenticated;
revoke all on public.safety_events, public.outbound_deliveries from anon;
revoke insert, update, delete, truncate on public.safety_events, public.outbound_deliveries from authenticated;

-- ---------------------------------------------------------------------------
-- Model routes for the new S4 roles (ADR-005, docs/02 7.3). `safety_moderator`
-- is BUDGET_EXEMPT (policy.ts) — no economy model, ignores the budget
-- entirely (NFR-SAFE-13). Reserve/escalation providers use the OpenAI
-- adapter already built in S3 (`openaiStructured`); exact GPT-5.6 model ids
-- are not yet confirmed in the OpenAI console — same caveat already
-- recorded for `lesson_review`/`indexing_structure` (docs/STATUS.md).
-- ---------------------------------------------------------------------------
create or replace function app_private.seed_s4_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, fallback_provider, fallback_model, escalation_provider, escalation_model, economy_provider, economy_model, params)
  values
    (p_family, 'safety_moderator', 'anthropic', 'claude-haiku-4-5', 'openai', 'gpt-5.6-terra', 'anthropic', 'claude-sonnet-5', null, null,
     '{"max_tokens": 400, "effort": "low", "timeout_ms": 15000}'::jsonb),
    (p_family, 'friend_chat', 'anthropic', 'claude-sonnet-5', 'openai', 'gpt-5.6-terra', null, null, 'anthropic', 'claude-haiku-4-5',
     '{"max_tokens": 1500, "effort": "low", "timeout_ms": 30000}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_s4_model_routes(uuid) from public;

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
  return new;
end;
$$;
-- Trigger already exists (same name, S1); no need to recreate it.

-- Existing families (S0-S3 already deployed) get the new roles too.
select app_private.seed_s4_model_routes(f.id) from public.families f;

-- `notifications.type` check already allows arbitrary lowercase identifiers
-- (S0: `type ~ '^[a-z][a-z0-9_.]*$'`) — no migration needed for the new S4
-- notification types (`safety_alert`, `external_delivery_failed`,
-- `telegram_linked`, `break_missed`, `break_taken`).
