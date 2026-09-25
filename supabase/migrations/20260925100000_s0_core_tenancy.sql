-- =============================================================================
-- S0 / core tenancy: families, app users & roles, RLS helper functions,
-- scrubbing of Google profile name/photo from Supabase Auth metadata.
--
-- Requirements: US-1.1, US-1.2, NFR-PRIV-4, NFR-PRIV-11; ADR-002, ADR-018 (K-1, K-2, K-8).
-- Rules:
--   * every table with family data has `family_id NOT NULL` + index + RLS;
--   * every policy is `family_id = app_family_id() AND <role rule>`;
--   * browsers never write directly: no INSERT/UPDATE/DELETE policies, all
--     business writes go through server routes using the service role.
-- =============================================================================

create schema if not exists app_private;
revoke all on schema app_private from public;

-- Generic updated_at maintenance -------------------------------------------------
create or replace function app_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Families (tenant) — ADR-018 K-1 ---------------------------------------------
create table public.families (
  id          uuid primary key default gen_random_uuid(),
  timezone    text not null,
  locale      text not null,
  created_at  timestamptz not null default now()
);
comment on table public.families is
  'Tenant. MVP has exactly one row; timezone/locale come from family defaults config (ADR-018 K-4).';

-- App users: auth user -> family -> role. No name, photo or e-mail (NFR-PRIV-11).
create table public.app_users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid not null unique references auth.users (id) on delete cascade,
  family_id     uuid not null references public.families (id) on delete cascade,
  role          text not null check (role in ('parent', 'child')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index app_users_family_id_idx on public.app_users (family_id);
create trigger app_users_touch before update on public.app_users
  for each row execute function app_private.touch_updated_at();
comment on table public.app_users is
  'Created only by the server after the allowlist check (ADR-002). Deliberately has no name/e-mail/photo columns.';

-- RLS helper functions (ADR-018 K-2). SECURITY DEFINER so they can read
-- app_users regardless of the caller's policies; they only ever return data
-- about the calling auth user. Unknown user -> NULL -> no rows anywhere.
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.role from public.app_users u where u.auth_user_id = auth.uid()
$$;

create or replace function public.app_family_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.family_id from public.app_users u where u.auth_user_id = auth.uid()
$$;

create or replace function public.app_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from public.app_users u where u.auth_user_id = auth.uid()
$$;

revoke all on function public.app_role() from public, anon;
revoke all on function public.app_family_id() from public, anon;
revoke all on function public.app_user_id() from public, anon;
grant execute on function public.app_role() to authenticated, service_role;
grant execute on function public.app_family_id() to authenticated, service_role;
grant execute on function public.app_user_id() to authenticated, service_role;

-- RLS: families & app_users ----------------------------------------------------
alter table public.families enable row level security;
alter table public.app_users enable row level security;

create policy families_select_own on public.families
  for select to authenticated
  using (id = (select public.app_family_id()));

-- Parent sees all family members; child sees only her own row.
create policy app_users_select on public.app_users
  for select to authenticated
  using (
    family_id = (select public.app_family_id())
    and (
      (select public.app_role()) = 'parent'
      or auth_user_id = (select auth.uid())
    )
  );

revoke all on public.families from anon;
revoke all on public.app_users from anon;
revoke insert, update, delete, truncate on public.families from authenticated;
revoke insert, update, delete, truncate on public.app_users from authenticated;

-- Google profile scrubbing (NFR-PRIV-11, ADR-002 p.3) -------------------------
-- Supabase Auth copies Google claims into metadata. We strip name and photo on
-- every insert/update; only the e-mail/subject needed for the allowlist remain.
create or replace function app_private.scrub_google_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  scrubbed_keys constant text[] :=
    array['name', 'full_name', 'given_name', 'family_name', 'picture', 'avatar_url'];
begin
  if tg_table_name = 'users' then
    new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb) - scrubbed_keys;
  elsif tg_table_name = 'identities' then
    new.identity_data := coalesce(new.identity_data, '{}'::jsonb) - scrubbed_keys;
  end if;
  return new;
end;
$$;

create trigger scrub_google_profile
  before insert or update on auth.users
  for each row execute function app_private.scrub_google_profile();

create trigger scrub_google_profile
  before insert or update on auth.identities
  for each row execute function app_private.scrub_google_profile();
