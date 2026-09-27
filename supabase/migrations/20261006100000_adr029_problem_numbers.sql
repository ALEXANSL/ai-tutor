-- ADR-029 (US-2.8/US-8.7): problem-number recognition during textbook
-- indexing, and the data an exact "поясни задачу №N" lookup needs.
--
-- `material_problems` is a new table, not a jsonb array on `materials`/
-- `topics` (see the ADR's Альтернативи): US-8.7 КП-7 needs an exact,
-- indexed lookup ("чи є задача №117 у цій темі"), which only a real column +
-- unique index gives.
create table if not exists public.material_problems (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  material_id      uuid not null references public.materials (id) on delete cascade,
  section_id       uuid references public.material_sections (id) on delete set null,
  topic_id         uuid references public.topics (id) on delete set null,
  number           text not null check (number = trim(number) and number !~ '\s' and char_length(number) between 1 and 12),
  page             integer not null,
  source           text not null default 'ai' check (source in ('ai')),
  created_at       timestamptz not null default now()
);
comment on table public.material_problems is
  'ADR-029 (US-2.8): numbered textbook exercises/problems, recognized ONCE during ingest.structure (indexing_structure) — never invented, only what the model unambiguously saw in the outline (КП-2). No manual-correction UI in MVP (source is always ''ai''): re-indexing fully rebuilds this material''s rows (delete+insert) instead of preserving row identity like material_sections/topics — nothing outside this table holds a stable FK to material_problems.id (lessons'' sourceRefs and the chat''s messages.meta both look a row up BY VALUE: material_id+page+number, never by id), so identity-preservation would add nothing.';

-- Exact (never fuzzy!) lookup by number within a topic — the basis of
-- US-8.7 КП-7.
create unique index if not exists material_problems_topic_number_uidx
  on public.material_problems (material_id, topic_id, number) where topic_id is not null;
create index if not exists material_problems_material_number_idx
  on public.material_problems (material_id, number);
create index if not exists material_problems_owner_idx on public.material_problems (owner_family_id);

alter table public.material_problems enable row level security;
drop policy if exists material_problems_select_parent on public.material_problems;
create policy material_problems_select_parent on public.material_problems for select to authenticated
  using (owner_family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');
revoke all on public.material_problems from anon;
revoke insert, update, delete, truncate on public.material_problems from authenticated;

-- Same principle as `assign_chunk_structure` (S1): the narrowest page range
-- containing the problem's page.
create or replace function public.assign_problem_structure(p_family_id uuid, p_material_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with upd as (
    update public.material_problems p
       set section_id = (
             select s.id from public.material_sections s
              where s.material_id = p.material_id and p.page between s.page_from and s.page_to
              order by s.page_to - s.page_from, s.sort_order limit 1),
           topic_id = (
             select t.id from public.topics t
              where t.material_id = p.material_id and p.page between t.page_from and t.page_to
              order by t.page_to - t.page_from, t.sort_order limit 1)
     where p.material_id = p_material_id and p.owner_family_id = p_family_id
    returning p.id
  )
  select count(*)::integer from upd
$$;
revoke all on function public.assign_problem_structure(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_problem_structure(uuid, uuid) to service_role;
