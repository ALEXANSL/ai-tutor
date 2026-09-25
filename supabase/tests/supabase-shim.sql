-- =============================================================================
-- Minimal Supabase compatibility shim for running migrations and RLS tests on
-- a plain local PostgreSQL (no Supabase account needed). NOT a migration.
-- Mirrors: roles anon/authenticated/service_role, auth.users/auth.identities,
-- auth.uid() from request.jwt claims, and Supabase's default grants.
-- =============================================================================
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

create table auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb,
  raw_app_meta_data   jsonb,
  created_at          timestamptz not null default now()
);

create table auth.identities (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null,
  identity_data  jsonb
);

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase grants broad table privileges by default and relies on RLS.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- Supabase installs extensions into the `extensions` schema, which is on the
-- default search_path (S1: pgvector, pg_trgm).
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
do $$ begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end $$;
