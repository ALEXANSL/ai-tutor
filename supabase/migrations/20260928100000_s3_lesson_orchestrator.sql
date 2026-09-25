-- =============================================================================
-- S3 / Lesson orchestrator: saved lesson library (E-19), lesson sessions as a
-- deterministic state machine (ADR-007), topic chats (E-8, US-8.1/8.2), and
-- the model routes the new roles use.
--
-- Requirements: US-6.1…6.7, US-8.1, 8.2, US-16.1…16.6, US-14.6, US-19.1,
-- US-2.6 (KP-3, 4); NFR-SAFE-8, NFR-SAFE-15, NFR-PLAT-6/7; docs/02 5, 8.2;
-- ADR-007, ADR-014, ADR-017, ADR-020.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- ON CONFLICT DO NOTHING everywhere). Requires the S0–S2 migrations.
-- =============================================================================

-- Lesson pacing settings live on the child (a per-child setting, not a
-- family-wide constant) — US-6.7 KP-1, US-16.4 (налашт.).
alter table public.child_profile
  add column if not exists lesson_minutes smallint not null default 30 check (lesson_minutes in (30, 45)),
  add column if not exists idle_hint_s smallint not null default 60 check (idle_hint_s between 10 and 600),
  add column if not exists idle_pause_s smallint not null default 180 check (idle_pause_s between 30 and 1800);

-- ---------------------------------------------------------------------------
-- Lesson library (ADR-014, E-19): generated once, reused without a new AI
-- call. `owner_family_id` nullable — shared content in the future (ADR-018).
-- No child data ever: nickname is a `{{nickname}}` placeholder in `content`,
-- substituted only when shown (US-19.1 KP-2, NFR-SAFE-8).
-- ---------------------------------------------------------------------------
create table if not exists public.library_items (
  id                  uuid primary key default gen_random_uuid(),
  owner_family_id     uuid references public.families (id) on delete cascade,
  module_code         text not null default 'school',
  subject_id          uuid not null references public.subjects (id) on delete cascade,
  topic_id            uuid not null references public.topics (id) on delete cascade,
  kind                text not null default 'block' check (kind in ('block', 'review_set', 'diagnostic_bank', 'alt_explanation')),
  title               text not null check (char_length(title) between 1 and 200),
  version             integer not null default 1 check (version >= 1),
  status              text not null default 'active' check (status in ('active', 'superseded')),
  replaced_reason     text,
  interest_tag        text,
  model               text,
  prompt_version      text,
  source_refs         jsonb not null default '[]'::jsonb,
  grade               smallint check (grade between 1 and 12),
  curriculum_version  text,
  estimated_minutes   smallint check (estimated_minutes between 3 and 15),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists library_items_owner_idx on public.library_items (owner_family_id);
create index if not exists library_items_topic_idx on public.library_items (topic_id, kind, status);
drop trigger if exists library_items_touch on public.library_items;
create trigger library_items_touch before update on public.library_items
  for each row execute function app_private.touch_updated_at();
comment on column public.library_items.source_refs is
  'Textbook / book citations for the whole block: [{materialId, materialTitle, page}] (US-6.1 KP-2).';

-- `visual.component` (ADR-020) makes a `slide` step animated (step_reveal) or
-- an `interactive` step's answer come from a registered, safely-evaluated
-- component; the model never returns HTML/JS/SVG (NFR-SAFE-15).
create table if not exists public.library_steps (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  item_id          uuid not null references public.library_items (id) on delete cascade,
  sort_order       smallint not null,
  type             text not null check (type in ('slide', 'choice', 'open', 'voice_dialog', 'match', 'mini_game', 'photo', 'interactive')),
  content          jsonb not null default '{}'::jsonb,
  visual           jsonb not null default '{}'::jsonb,
  source_refs      jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  unique (item_id, sort_order)
);
create index if not exists library_steps_owner_idx on public.library_steps (owner_family_id);
create index if not exists library_steps_item_idx on public.library_steps (item_id, sort_order);

-- ---------------------------------------------------------------------------
-- Lesson sessions: the orchestrator's state (ADR-007, docs/02 5.1, 5.2).
-- `family_id` is NOT NULL here — this is the child's own progress, never
-- shared content. `mode` keeps the full state-diagram vocabulary so later
-- slices (diagnostic/review/friend/break) need no migration; S3 uses only
-- lesson/practice/paused/summary (and the pre-start `choosing`, US-16.6).
-- ---------------------------------------------------------------------------
create table if not exists public.lesson_sessions (
  id                          uuid primary key default gen_random_uuid(),
  family_id                   uuid not null references public.families (id) on delete cascade,
  academic_year_id            uuid references public.academic_years (id) on delete set null,
  module_code                 text not null default 'school',
  child_profile_id            uuid not null references public.child_profile (id) on delete cascade,
  subject_id                  uuid not null references public.subjects (id) on delete cascade,
  topic_id                    uuid not null references public.topics (id) on delete cascade,
  mode                        text not null default 'choosing'
                                check (mode in ('choosing', 'diagnostic', 'lesson', 'practice', 'review', 'friend', 'break', 'paused', 'summary')),
  planned_minutes             smallint not null check (planned_minutes in (30, 45)),
  status                      text not null default 'active' check (status in ('active', 'paused', 'completed')),
  pause_reason                text check (pause_reason in ('manual_alert', 'air_alert', 'idle', 'network', 'budget_hard', 'parent_mode')),
  -- Offered at start (US-16.6 KP-1, US-9.1 KP-2) before the child picks one.
  candidate_library_item_ids  jsonb not null default '[]'::jsonb,
  current_block_order         smallint not null default 0,
  current_step_id             uuid references public.library_steps (id) on delete set null,
  active_seconds              integer not null default 0 check (active_seconds >= 0),
  budget_state_at_start       text,
  points_earned               integer not null default 0,
  started_at                  timestamptz not null default now(),
  paused_at                   timestamptz,
  resumed_at                  timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists lesson_sessions_family_idx on public.lesson_sessions (family_id, created_at desc);
create index if not exists lesson_sessions_child_idx on public.lesson_sessions (child_profile_id, status);
drop trigger if exists lesson_sessions_default_year on public.lesson_sessions;
create trigger lesson_sessions_default_year before insert on public.lesson_sessions
  for each row execute function public.set_default_academic_year();
drop trigger if exists lesson_sessions_touch on public.lesson_sessions;
create trigger lesson_sessions_touch before update on public.lesson_sessions
  for each row execute function app_private.touch_updated_at();

create table if not exists public.session_blocks (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families (id) on delete cascade,
  session_id       uuid not null references public.lesson_sessions (id) on delete cascade,
  library_item_id  uuid not null references public.library_items (id) on delete cascade,
  sort_order       smallint not null,
  status           text not null default 'pending' check (status in ('pending', 'active', 'done', 'skipped')),
  created_at       timestamptz not null default now(),
  unique (session_id, sort_order)
);
create index if not exists session_blocks_family_idx on public.session_blocks (family_id);
create index if not exists session_blocks_session_idx on public.session_blocks (session_id, sort_order);

-- `idempotency_key` (client UUID): an answer buffered offline and resent
-- after reconnecting never creates a duplicate row (US-6.5 KP-2).
create table if not exists public.step_attempts (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families (id) on delete cascade,
  session_id       uuid not null references public.lesson_sessions (id) on delete cascade,
  step_id          uuid not null references public.library_steps (id) on delete cascade,
  attempt_no       smallint not null default 1 check (attempt_no >= 1),
  answer           jsonb not null default '{}'::jsonb,
  channel          text not null default 'text' check (channel in ('choice', 'text', 'voice', 'photo')),
  verdict          text check (verdict in ('correct', 'partial', 'incorrect')),
  error_type       text,
  guess_flag       boolean not null default false,
  latency_ms       integer,
  idempotency_key  uuid not null unique,
  created_at       timestamptz not null default now()
);
create index if not exists step_attempts_family_idx on public.step_attempts (family_id);
create index if not exists step_attempts_session_idx on public.step_attempts (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Chats: "предмет → тема" (US-8.1, 8.2) + "ШІ-друг" (kind, from S4) and a
-- future private kind (US-8.6) — no schema change needed later.
-- ---------------------------------------------------------------------------
create table if not exists public.chats (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families (id) on delete cascade,
  child_profile_id   uuid not null references public.child_profile (id) on delete cascade,
  kind               text not null default 'subject_topic' check (kind in ('subject_topic', 'friend', 'private')),
  subject_id         uuid references public.subjects (id) on delete cascade,
  topic_id           uuid references public.topics (id) on delete cascade,
  parent_visibility  text not null default 'full' check (parent_visibility in ('full', 'summary')),
  created_at         timestamptz not null default now(),
  check ((kind = 'subject_topic') = (topic_id is not null))
);
create unique index if not exists chats_one_per_topic_idx
  on public.chats (child_profile_id, topic_id) where kind = 'subject_topic';
create index if not exists chats_family_idx on public.chats (family_id);

create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families (id) on delete cascade,
  chat_id       uuid not null references public.chats (id) on delete cascade,
  session_id    uuid references public.lesson_sessions (id) on delete set null,
  author        text not null check (author in ('child', 'ai', 'system', 'parent')),
  type          text not null default 'text' check (type in ('text', 'voice_transcript', 'image', 'system')),
  content       text not null,
  source_refs   jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists messages_family_idx on public.messages (family_id);
create index if not exists messages_chat_idx on public.messages (chat_id, created_at);

-- ---------------------------------------------------------------------------
-- RLS (NFR-PRIV-4). All writes go through server actions with service_role
-- (ADR-018 K-2); these policies cover reads only.
-- ---------------------------------------------------------------------------
alter table public.library_items enable row level security;
alter table public.library_steps enable row level security;
alter table public.lesson_sessions enable row level security;
alter table public.session_blocks enable row level security;
alter table public.step_attempts enable row level security;
alter table public.chats enable row level security;
alter table public.messages enable row level security;

drop policy if exists library_items_select on public.library_items;
create policy library_items_select on public.library_items
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (
      (select public.app_role()) = 'parent'
      or ((select public.app_role()) = 'child' and status = 'active')
    )
  );

drop policy if exists library_steps_select on public.library_steps;
create policy library_steps_select on public.library_steps
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and exists (
      select 1 from public.library_items li
       where li.id = library_steps.item_id
         and ((select public.app_role()) = 'parent' or li.status = 'active')
    )
  );

drop policy if exists lesson_sessions_select on public.lesson_sessions;
create policy lesson_sessions_select on public.lesson_sessions
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and (
      (select public.app_role()) = 'parent'
      or exists (
        select 1 from public.child_profile cp
         where cp.id = lesson_sessions.child_profile_id and cp.app_user_id = (select public.app_user_id())
      )
    )
  );

drop policy if exists session_blocks_select on public.session_blocks;
create policy session_blocks_select on public.session_blocks
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and exists (
      select 1 from public.lesson_sessions s
       where s.id = session_blocks.session_id
         and ((select public.app_role()) = 'parent'
              or exists (select 1 from public.child_profile cp
                          where cp.id = s.child_profile_id and cp.app_user_id = (select public.app_user_id())))
    )
  );

drop policy if exists step_attempts_select on public.step_attempts;
create policy step_attempts_select on public.step_attempts
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and exists (
      select 1 from public.lesson_sessions s
       where s.id = step_attempts.session_id
         and ((select public.app_role()) = 'parent'
              or exists (select 1 from public.child_profile cp
                          where cp.id = s.child_profile_id and cp.app_user_id = (select public.app_user_id())))
    )
  );

drop policy if exists chats_select on public.chats;
create policy chats_select on public.chats
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and (
      (select public.app_role()) = 'parent'
      or exists (select 1 from public.child_profile cp
                  where cp.id = chats.child_profile_id and cp.app_user_id = (select public.app_user_id()))
    )
  );

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and exists (
      select 1 from public.chats c
       where c.id = messages.chat_id
         and ((select public.app_role()) = 'parent'
              or exists (select 1 from public.child_profile cp
                          where cp.id = c.child_profile_id and cp.app_user_id = (select public.app_user_id())))
    )
  );

revoke all on public.library_items, public.library_steps, public.lesson_sessions,
  public.session_blocks, public.step_attempts, public.chats, public.messages from anon;
revoke insert, update, delete, truncate on public.library_items, public.library_steps,
  public.lesson_sessions, public.session_blocks, public.step_attempts, public.chats,
  public.messages from authenticated;

-- ---------------------------------------------------------------------------
-- Model routes for the new S3 roles (ADR-005). Fallback providers for
-- `lesson_generation` / `tutor_chat` / `answer_evaluation` are left unset for
-- the same reason as `indexing_structure` in S1 (docs/STATUS.md): the exact
-- GPT-5.6 model ids are not yet confirmed in the OpenAI console. No
-- `budget_policy` is set, so budget mode falls back to the primary model,
-- matching US-11.5 KP-6 ("якщо економ-модель ролі не задано — на основній").
-- ---------------------------------------------------------------------------
create or replace function app_private.seed_s3_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, escalation_provider, escalation_model, params)
  values
    (p_family, 'lesson_generation', 'anthropic', 'claude-opus-5-5', null, null,
     '{"max_tokens": 16000, "effort": "medium", "timeout_ms": 120000}'::jsonb),
    (p_family, 'tutor_chat', 'anthropic', 'claude-sonnet-5', 'anthropic', 'claude-opus-5-5',
     '{"max_tokens": 2000, "effort": "low", "timeout_ms": 30000}'::jsonb),
    (p_family, 'answer_evaluation', 'anthropic', 'claude-sonnet-5', 'anthropic', 'claude-opus-5-5',
     '{"max_tokens": 1000, "effort": "low", "timeout_ms": 20000}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_s3_model_routes(uuid) from public;

create or replace function app_private.families_seed_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.seed_default_model_routes(new.id);
  perform app_private.seed_s3_model_routes(new.id);
  return new;
end;
$$;
-- Trigger already exists from S1 (same name); no need to recreate it, only
-- the function body changed and `create or replace` above already applied.

-- Existing families (S0/S1 are already deployed).
select app_private.seed_s3_model_routes(f.id) from public.families f;

-- Existing families' math subject gets `allowed_components` too (new families
-- pick it up from config/family-defaults.json, ADR-020 §2). Additive merge,
-- never overwrites a value the parent may already have set by hand.
update public.subjects
   set config = config || '{"allowed_components": ["drag_sort"]}'::jsonb
 where code = 'math'
   and not (config ? 'allowed_components');
