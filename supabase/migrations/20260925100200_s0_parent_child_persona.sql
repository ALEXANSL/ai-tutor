-- =============================================================================
-- S0 / parent settings (PIN), child profile (nickname, tutor persona),
-- tutor voice catalog (empty until S12), persona change log, notification
-- centre, and the server-only registration function.
--
-- Requirements: US-1.5, US-1.6, US-1.7 (KP-1..3, 11), US-11.6, US-12.3,
-- NFR-PRIV-4, NFR-PRIV-9; docs/02-architecture.md 8.2, 8.3.
-- =============================================================================

-- Parent settings: one row per family (the family's tablet PIN etc.). ----------
create table public.parent_settings (
  family_id               uuid primary key references public.families (id) on delete cascade,
  -- argon2id(PIN, salt, secret = PIN_PEPPER). Never selectable by clients.
  pin_hash                text,
  pin_updated_at          timestamptz,
  pin_failed              smallint not null default 0 check (pin_failed >= 0),
  pin_locked_until        timestamptz,
  -- Configurable policy (US-1.5 KP-2, KP-3 "(налашт.)").
  pin_max_attempts        smallint not null default 5 check (pin_max_attempts between 3 and 10),
  pin_lock_minutes        smallint not null default 15 check (pin_lock_minutes between 1 and 240),
  parent_mode_idle_min    smallint not null default 5 check (parent_mode_idle_min between 1 and 60),
  -- Suggested tutor names: {"f": [{name, hint}], "m": [{name, hint}]} (PM-21).
  tutor_name_options      jsonb not null default '{"f": [], "m": []}'::jsonb,
  -- "Child may change tutor persona (name, voice, avatar)" — default on (PM-23).
  persona_child_editable  jsonb not null default '{"name": true, "voice": true, "avatar": true}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger parent_settings_touch before update on public.parent_settings
  for each row execute function app_private.touch_updated_at();

-- Tutor voice catalog approved by the parent (ADR-006; filled in S12). ---------
create table public.tutor_voices (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families (id) on delete cascade,
  provider             text not null default 'elevenlabs',
  provider_voice_id    text not null,
  gender               text not null check (gender in ('f', 'm')),
  label_uk             text not null,
  sample_storage_path  text,
  is_default           boolean not null default false,
  status               text not null default 'active' check (status in ('active', 'retiring', 'disabled')),
  disable_at           timestamptz,
  approved_by          uuid references public.app_users (id) on delete set null,
  approved_at          timestamptz,
  created_at           timestamptz not null default now(),
  unique (family_id, provider, provider_voice_id)
);
create index tutor_voices_family_id_idx on public.tutor_voices (family_id);

-- Child profile: data of the child, not of a school year (NFR-PLAT-7 (b)). ----
create table public.child_profile (
  id                       uuid primary key default gen_random_uuid(),
  family_id                uuid not null references public.families (id) on delete cascade,
  app_user_id              uuid not null unique references public.app_users (id) on delete cascade,
  -- The only "name" ever passed to models (D-30, NFR-SAFE-8).
  nickname                 text check (char_length(nickname) between 2 and 20),
  tutor_name               text check (char_length(tutor_name) between 2 and 20),
  tutor_name_source        text check (tutor_name_source in ('suggested', 'custom')),
  -- NULL = default voice (female, D-18); voice choice arrives in S12.
  tutor_voice_id           uuid references public.tutor_voices (id) on delete set null,
  persona_updated_at       timestamptz,
  onboarding_completed_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index child_profile_family_id_idx on public.child_profile (family_id);
create trigger child_profile_touch before update on public.child_profile
  for each row execute function app_private.touch_updated_at();

-- Persona / nickname change log for the parent (US-1.6 KP-3, US-1.7 KP-11). ---
create table public.persona_changes (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families (id) on delete cascade,
  child_profile_id  uuid not null references public.child_profile (id) on delete cascade,
  field             text not null check (field in ('nickname', 'name', 'voice', 'avatar')),
  old_value         text,
  new_value         text,
  changed_by        text not null check (changed_by in ('child', 'parent')),
  created_at        timestamptz not null default now()
);
create index persona_changes_family_id_idx on public.persona_changes (family_id, created_at desc);

-- Notification centre (US-11.6). Visible only to the parent. -----------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  type        text not null check (type ~ '^[a-z][a-z0-9_.]*$'),
  severity    text not null default 'normal' check (severity in ('normal', 'urgent')),
  payload     jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_family_created_idx on public.notifications (family_id, created_at desc);
create index notifications_family_unread_idx on public.notifications (family_id) where read_at is null;

-- RLS -------------------------------------------------------------------------
alter table public.parent_settings enable row level security;
alter table public.tutor_voices enable row level security;
alter table public.child_profile enable row level security;
alter table public.persona_changes enable row level security;
alter table public.notifications enable row level security;

create policy parent_settings_select_parent on public.parent_settings
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

create policy tutor_voices_select on public.tutor_voices
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and (
      (select public.app_role()) = 'parent'
      or ((select public.app_role()) = 'child' and status = 'active')
    )
  );

create policy child_profile_select on public.child_profile
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and (
      (select public.app_role()) = 'parent'
      or ((select public.app_role()) = 'child' and app_user_id = (select public.app_user_id()))
    )
  );

create policy persona_changes_select_parent on public.persona_changes
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

create policy notifications_select_parent on public.notifications
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

revoke all on public.parent_settings, public.tutor_voices, public.child_profile,
  public.persona_changes, public.notifications from anon;
revoke insert, update, delete, truncate on public.parent_settings, public.tutor_voices,
  public.child_profile, public.persona_changes, public.notifications from authenticated;

-- The PIN hash never leaves the server: column-level grant without pin_hash.
revoke select on public.parent_settings from authenticated;
grant select (
  family_id, pin_updated_at, pin_failed, pin_locked_until, pin_max_attempts,
  pin_lock_minutes, parent_mode_idle_min, tutor_name_options, persona_child_editable,
  created_at, updated_at
) on public.parent_settings to authenticated;

-- Registration (server only, after the allowlist check) ----------------------
-- MVP is a single family (ADR-018 K-8): the first allowlisted login creates
-- the family and its defaults from config; later logins join it. For a SaaS
-- version this is replaced by invitations without schema changes.
create or replace function public.register_app_user(
  p_auth_user_id uuid,
  p_role text,
  p_defaults jsonb
)
returns table (app_user_id uuid, family_id uuid, role text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_family uuid;
  v_user   uuid;
  v_year   jsonb := p_defaults -> 'academicYear';
begin
  if p_role not in ('parent', 'child') then
    raise exception 'invalid role %', p_role using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('ai_tutor.register_app_user'));

  select f.id into v_family from public.families f order by f.created_at limit 1;

  if v_family is null then
    insert into public.families (timezone, locale)
    values (p_defaults ->> 'timezone', p_defaults ->> 'locale')
    returning id into v_family;

    insert into public.learning_modules (family_id, code, enabled, config)
    select v_family, m ->> 'code', coalesce((m ->> 'enabled')::boolean, true),
           coalesce(m -> 'config', '{}'::jsonb)
      from jsonb_array_elements(coalesce(p_defaults -> 'learningModules', '[]'::jsonb)) m;

    if v_year is not null then
      insert into public.academic_years (family_id, label, grade, starts_on, ends_on, status)
      values (v_family, v_year ->> 'label', (v_year ->> 'grade')::smallint,
              (v_year ->> 'startsOn')::date, (v_year ->> 'endsOn')::date, 'active');
    end if;

    insert into public.subjects (owner_family_id, code, name_uk, active, is_stub, sort_order, config)
    select v_family, s.value ->> 'code', s.value ->> 'nameUk',
           coalesce((s.value ->> 'active')::boolean, false),
           coalesce((s.value ->> 'isStub')::boolean, false),
           s.ordinality::integer * 10,
           coalesce(s.value -> 'config', '{}'::jsonb)
      from jsonb_array_elements(coalesce(p_defaults -> 'subjects', '[]'::jsonb))
           with ordinality as s(value, ordinality);

    insert into public.parent_settings (family_id, tutor_name_options)
    values (v_family, coalesce(p_defaults -> 'tutorNameOptions', '{"f": [], "m": []}'::jsonb));
  end if;

  insert into public.app_users as u (auth_user_id, family_id, role)
  values (p_auth_user_id, v_family, p_role)
  on conflict (auth_user_id) do update set role = excluded.role
  returning u.id into v_user;

  if p_role = 'child' then
    insert into public.child_profile (family_id, app_user_id)
    values (v_family, v_user)
    on conflict on constraint child_profile_app_user_id_key do nothing;
  end if;

  return query select v_user, v_family, p_role;
end;
$$;

revoke all on function public.register_app_user(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_app_user(uuid, text, jsonb) to service_role;
