-- =============================================================================
-- S0 / registries in data: learning modules (ADR-017), academic years and
-- grade (ADR-021, NFR-PLAT-7), subjects (ADR-017 (a), US-3.4).
--
-- No year, grade, subject or module values are hard-coded here: they are
-- inserted from the family defaults config by `register_app_user` (below in
-- a later migration) or by the parent in later slices.
-- =============================================================================

-- Learning modules (ADR-017): MVP has one row `school` per family. ---------------
create table public.learning_modules (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  code        text not null check (code ~ '^[a-z][a-z0-9_.]*$'),
  enabled     boolean not null default true,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (family_id, code)
);
create index learning_modules_family_id_idx on public.learning_modules (family_id);

-- Academic years (ADR-021): a dimension, not a constant. -----------------------
create table public.academic_years (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  label       text not null check (char_length(label) between 1 and 40),
  grade       smallint not null check (grade between 1 and 12),
  starts_on   date not null,
  ends_on     date not null,
  status      text not null default 'active' check (status in ('active', 'archived')),
  created_at  timestamptz not null default now(),
  check (ends_on > starts_on)
);
create index academic_years_family_id_idx on public.academic_years (family_id);
-- Exactly one active year per family at a time.
create unique index academic_years_one_active_per_family
  on public.academic_years (family_id) where status = 'active';

-- Trigger function for later tables that carry `academic_year_id`
-- (lesson_sessions, chats, diagnostic_runs, homework, reports, points_ledger):
-- when not provided, the family's active year is used (ADR-021 p.1).
create or replace function public.set_default_academic_year()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.academic_year_id is null then
    select y.id into new.academic_year_id
      from public.academic_years y
     where y.family_id = new.family_id and y.status = 'active';
    if new.academic_year_id is null then
      raise exception 'no active academic year for family %', new.family_id
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.set_default_academic_year() from public, anon, authenticated;

-- Subjects = data (ADR-017 (a)). Learning content has nullable owner_family_id:
-- NULL = shared content in the future; in MVP everything is family-owned (ADR-018 K-3).
create table public.subjects (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  code             text not null check (code ~ '^[a-z][a-z0-9_.]*$'),
  name_uk          text not null,
  active           boolean not null default false,
  is_stub          boolean not null default false,
  sort_order       integer not null default 0,
  config           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  unique nulls not distinct (owner_family_id, code)
);
create index subjects_owner_family_id_idx on public.subjects (owner_family_id);
comment on column public.subjects.is_stub is
  'Stub subjects (e.g. art, technology) show a "coming soon" screen and never call AI (US-3.4).';
comment on column public.subjects.config is
  'Subject registry config: icon, language mode, allowed step/component types, grading profile, continues_subject_id (ADR-017, ADR-021).';

-- RLS ------------------------------------------------------------------------
alter table public.learning_modules enable row level security;
alter table public.academic_years enable row level security;
alter table public.subjects enable row level security;

create policy learning_modules_select on public.learning_modules
  for select to authenticated
  using (family_id = (select public.app_family_id()));

create policy academic_years_select on public.academic_years
  for select to authenticated
  using (family_id = (select public.app_family_id()));

create policy subjects_select on public.subjects
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    or (owner_family_id is null and (select public.app_family_id()) is not null)
  );

revoke all on public.learning_modules, public.academic_years, public.subjects from anon;
revoke insert, update, delete, truncate
  on public.learning_modules, public.academic_years, public.subjects from authenticated;
