-- S31 (E-22, US-22.1..22.3, ADR-030): parent-managed school subjects and
-- courses, course groups, and the "grey tile vs fully hidden" visibility
-- split (VP-52).
--
-- `INSERT`/`UPDATE` on `subjects` was already revoked from `authenticated`
-- (20260925100100_s0_modules_years_subjects.sql) — this migration adds the
-- missing SECURITY DEFINER RPCs (the same two-layer "parent only" gate as
-- `public.set_current_topic`, 20260927100000_s2_current_topic_atomic.sql):
-- the server action calls `requireParentAccess()` before ever invoking the
-- RPC, and the RPC independently re-verifies `owner_family_id` against the
-- caller's family, never trusting client input.
--
-- Idempotent: safe to re-run (guards on existing columns/tables/indexes,
-- `create or replace function`).

-- 1) subjects.kind — point extension, no new learning_module and no rewrite
--    of the indexing/lesson pipeline (ADR-017 already treats "subject = a
--    row"). `default 'school_subject'` covers all existing rows with no
--    manual backfill: Postgres fills the DEFAULT for existing rows
--    atomically in the same ADD COLUMN command.
alter table public.subjects
  add column if not exists kind text not null default 'school_subject'
    check (kind in ('school_subject', 'course'));
comment on column public.subjects.kind is
  'US-22.1/22.2 (E-22): "school_subject" — a NUS school subject (all 10 standard
   ones included, always this kind, never course — KP-7 US-22.1); "course" — a
   parent-defined course outside the school programme. Governs (a) a separate
   duplicate-name check scoped per kind, (b) child visibility when
   active=false: school_subject -> grey tile (unchanged), course -> fully
   hidden (VP-52).';

-- 2) course_groups — a new, optional "Group -> Courses" level (US-22.3),
--    mirroring "Subject -> Topics".
create table if not exists public.course_groups (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid not null references public.families (id) on delete cascade,
  name_uk          text not null check (char_length(name_uk) between 1 and 120),
  active           boolean not null default false,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists course_groups_owner_idx on public.course_groups (owner_family_id);
drop trigger if exists course_groups_touch on public.course_groups;
create trigger course_groups_touch before update on public.course_groups
  for each row execute function app_private.touch_updated_at();

-- Group name duplicate check — case-insensitive, trimmed, within the family
-- (КП-1 US-22.3).
create unique index if not exists course_groups_owner_name_uidx
  on public.course_groups (owner_family_id, lower(trim(name_uk)));

-- 3) subjects.group_id — nullable, only meaningful for kind='course' (КП-2
--    US-22.3: a course belongs to at most one group; a school subject NEVER
--    has a group — enforced in the RPCs below, not a CHECK, because a plain
--    CHECK cannot see another table's row without a volatile/subquery
--    expression; the RPC gate is sufficient because it is the only write
--    path).
alter table public.subjects
  add column if not exists group_id uuid references public.course_groups (id) on delete set null;
create index if not exists subjects_group_id_idx on public.subjects (group_id) where group_id is not null;

-- 4) Subject/course name duplicate check — case-insensitive, trim+lower,
--    SEPARATE per kind (КП-2 US-22.1, КП-2 US-22.2: a school subject
--    "Історія" and a future course "Історія" do not conflict). A partial
--    unique index, not an extension of `unique(owner_family_id, code)` —
--    `code` is an auto-generated technical slug and does not catch a
--    duplicate by human-readable name.
create unique index if not exists subjects_owner_kind_name_uidx
  on public.subjects (owner_family_id, kind, lower(trim(name_uk)))
  where owner_family_id is not null;

-- RLS: course_groups reads only within the caller's own family (the same
-- pattern as subjects_select); no direct writes from the browser.
alter table public.course_groups enable row level security;
drop policy if exists course_groups_select on public.course_groups;
create policy course_groups_select on public.course_groups
  for select to authenticated
  using (owner_family_id = (select public.app_family_id()));
revoke all on public.course_groups from anon;
revoke insert, update, delete, truncate on public.course_groups from authenticated;

-- =============================================================================
-- 2) SECURITY DEFINER RPCs — "parent only" gate.
--
-- Gate is enforced on two levels, mirroring `set_current_topic` exactly:
--   1. The server action (`requireParentAccess()`) is the real "parent only"
--      gate, run *before* the RPC is ever called.
--   2. The RPC itself is `security definer`, `revoke all ... from public,
--      anon, authenticated; grant execute ... to service_role;`, called only
--      through the service client, and independently re-checks
--      `owner_family_id = p_family_id` for anything the caller passed in —
--      never trusting the client even inside an already-gated call.
-- =============================================================================

-- slugify_subject_code: technical `code` slug from the human name, never
-- shown to the parent or child. Best-effort ASCII slug (works well for
-- Latin-script names); anything that would not satisfy the existing
-- `code ~ '^[a-z][a-z0-9_.]*$'` check (e.g. a Ukrainian name) falls back to
-- a simple `subject_<uuid>` value — cosmetics do not matter here (ADR-030),
-- so a fiddly transliteration is deliberately not attempted. Collisions
-- (rare, only within the same family) get a numeric suffix.
create or replace function public.slugify_subject_code(p_family_id uuid, p_name_uk text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base      text;
  v_candidate text;
  v_suffix    integer := 0;
begin
  v_base := lower(trim(p_name_uk));
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '_', 'g');
  v_base := trim(both '_' from v_base);
  v_base := left(v_base, 60);
  if v_base = '' or v_base !~ '^[a-z]' then
    v_base := 'subject_' || replace(gen_random_uuid()::text, '-', '');
  end if;

  v_candidate := v_base;
  loop
    exit when not exists (
      select 1 from public.subjects where owner_family_id = p_family_id and code = v_candidate
    );
    v_suffix := v_suffix + 1;
    v_candidate := v_base || '_' || v_suffix;
  end loop;
  return v_candidate;
end;
$$;
revoke all on function public.slugify_subject_code(uuid, text) from public, anon, authenticated;
grant execute on function public.slugify_subject_code(uuid, text) to service_role;

-- add_subject: a school subject (kind='school_subject', ALWAYS — КП-7
-- US-22.1) — inactive by default, same as the other subjects before
-- activation (activation goes through set_subject_active below, the same
-- path as for the standard 10 subjects).
create or replace function public.add_subject(p_family_id uuid, p_name_uk text)
returns table (out_id uuid, out_code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := trim(p_name_uk);
  v_code  text;
  v_id    uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = 'school_subject'
       and lower(trim(name_uk)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  v_code := public.slugify_subject_code(p_family_id, v_name);
  insert into public.subjects (owner_family_id, code, name_uk, kind, active, is_stub)
  values (p_family_id, v_code, v_name, 'school_subject', false, false)
  returning id, code into v_id, v_code;
  return query select v_id, v_code;
end; $$;
revoke all on function public.add_subject(uuid, text) from public, anon, authenticated;
grant execute on function public.add_subject(uuid, text) to service_role;

-- rename_subject: same duplicate check, same kind (kind is never changed
-- here — school_subject <-> course conversion is out of scope for
-- US-22.1..22.3).
create or replace function public.rename_subject(p_family_id uuid, p_subject_id uuid, p_name_uk text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
  v_kind text;
begin
  select kind into v_kind from public.subjects
   where id = p_subject_id and owner_family_id = p_family_id;
  if v_kind is null then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = v_kind
       and lower(trim(name_uk)) = lower(v_name) and id <> p_subject_id
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  update public.subjects set name_uk = v_name where id = p_subject_id;
end; $$;
revoke all on function public.rename_subject(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rename_subject(uuid, uuid, text) to service_role;

-- set_subject_active: the only write path to the existing subjects.active
-- (D-101) — same ownership check as the other RPCs; used for both
-- school subjects and courses (the row shape is the same, only the child
-- visibility rule differs by kind — step 3 below).
create or replace function public.set_subject_active(p_family_id uuid, p_subject_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.subjects set active = p_active
   where id = p_subject_id and owner_family_id = p_family_id and is_stub = false;
  if not found then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;
end; $$;
revoke all on function public.set_subject_active(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_subject_active(uuid, uuid, boolean) to service_role;

-- add_course: kind='course' ALWAYS; group_id is optional, its ownership is
-- checked here (not a CHECK, see p.1 above); duplicates are checked
-- separately among courses (КП-2 US-22.2).
create or replace function public.add_course(p_family_id uuid, p_name_uk text, p_group_id uuid default null)
returns table (out_id uuid, out_code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
  v_code text;
  v_id   uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.course_groups where id = p_group_id and owner_family_id = p_family_id
  ) then
    raise exception using errcode = 'P0012', message = 'group_not_found';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = 'course'
       and lower(trim(name_uk)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  v_code := public.slugify_subject_code(p_family_id, v_name);
  insert into public.subjects
    (owner_family_id, code, name_uk, kind, active, is_stub, group_id, config)
  values
    (p_family_id, v_code, v_name, 'course', false, false, p_group_id,
     jsonb_build_object('requires_diagnostic', false)) -- КП-4 US-22.2: a course
                                                          -- does not require an
                                                          -- entry diagnostic by
                                                          -- default.
  returning id, code into v_id, v_code;
  return query select v_id, v_code;
end; $$;
revoke all on function public.add_course(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.add_course(uuid, text, uuid) to service_role;

-- update_course: rename + (re)assign group for an existing course, one RPC.
create or replace function public.update_course(
  p_family_id uuid, p_subject_id uuid, p_name_uk text, p_group_id uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
begin
  if not exists (
    select 1 from public.subjects
     where id = p_subject_id and owner_family_id = p_family_id and kind = 'course'
  ) then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.course_groups where id = p_group_id and owner_family_id = p_family_id
  ) then
    raise exception using errcode = 'P0012', message = 'group_not_found';
  end if;
  if exists (
    select 1 from public.subjects
     where owner_family_id = p_family_id and kind = 'course'
       and lower(trim(name_uk)) = lower(v_name) and id <> p_subject_id
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  update public.subjects set name_uk = v_name, group_id = p_group_id where id = p_subject_id;
end; $$;
revoke all on function public.update_course(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.update_course(uuid, uuid, text, uuid) to service_role;

-- add_course_group / rename_course_group / set_course_group_active mirror
-- add_subject/rename_subject/set_subject_active, just on course_groups.
create or replace function public.add_course_group(p_family_id uuid, p_name_uk text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
  v_id   uuid;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.course_groups
     where owner_family_id = p_family_id and lower(trim(name_uk)) = lower(v_name)
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  insert into public.course_groups (owner_family_id, name_uk, active)
  values (p_family_id, v_name, false) returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.add_course_group(uuid, text) from public, anon, authenticated;
grant execute on function public.add_course_group(uuid, text) to service_role;

create or replace function public.rename_course_group(p_family_id uuid, p_group_id uuid, p_name_uk text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(p_name_uk);
begin
  if not exists (select 1 from public.course_groups where id = p_group_id and owner_family_id = p_family_id) then
    raise exception using errcode = 'P0002', message = 'group_not_found';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception using errcode = 'P0010', message = 'invalid_name';
  end if;
  if exists (
    select 1 from public.course_groups
     where owner_family_id = p_family_id and lower(trim(name_uk)) = lower(v_name) and id <> p_group_id
  ) then
    raise exception using errcode = 'P0011', message = 'duplicate_name';
  end if;
  update public.course_groups set name_uk = v_name where id = p_group_id;
end; $$;
revoke all on function public.rename_course_group(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rename_course_group(uuid, uuid, text) to service_role;

create or replace function public.set_course_group_active(p_family_id uuid, p_group_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.course_groups set active = p_active
   where id = p_group_id and owner_family_id = p_family_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'group_not_found';
  end if;
end; $$;
revoke all on function public.set_course_group_active(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_course_group_active(uuid, uuid, boolean) to service_role;
