-- =============================================================================
-- ADR-032: incremental, per-section book structuring (real prod incident,
-- 2026-09-28 — structurally dense textbooks were hitting `max_tokens`/timeout
-- on the old single whole-book `indexing_structure` call).
--
-- Adds:
--  - `materials.status` new terminal value `ready_partial` (book usable, one
--    or more sections permanently failed their own structuring pass).
--  - `material_sections.status`/`status_detail` (mirrors `materials`'
--    pattern) so a section's own pending/indexing/ready/error state is
--    tracked independently of the book as a whole.
--  - New AI role `indexing_outline` (pass 1: section boundaries only).
--  - `search_chunks` (S1) now also serves `ready_partial` books — the whole
--    point of this ADR is that a book is usable as soon as its ready
--    sections are, not only once every section succeeds.
--
-- Safe to re-run in the Supabase SQL Editor.
-- Requires 20260926100000_s1_ai_router_costs_jobs.sql and
-- 20260926100100_s1_materials_search.sql.
-- =============================================================================

-- materials.status: add 'ready_partial' to the existing CHECK constraint.
alter table public.materials drop constraint if exists materials_status_check;
alter table public.materials add constraint materials_status_check
  check (status in ('queued', 'indexing', 'ready', 'ready_partial', 'error', 'scan_no_text',
                     'scan_awaiting_ocr', 'deferred', 'removed'));

-- material_sections: per-section structuring status (ADR-032), same shape as
-- `materials.status`/`status_detail` — 'pending' until its own
-- `ingest.structure_section` job runs, 'indexing' while running, 'ready' or
-- 'error' once its own retries are exhausted one way or the other.
alter table public.material_sections
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'indexing', 'ready', 'error')),
  add column if not exists status_detail text;

-- New AI role for pass 1 (ADR-032): small, reliable, cheap — section
-- boundaries only. Same model as `indexing_structure` for MVP (consistency
-- of book type/subject classification); a cheaper model for this specific
-- pass is a price/quality call for the PO, not decided here (see the ADR).
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
    (p_family, 'indexing_outline', 'anthropic', 'claude-opus-5-5',
     '{"max_tokens": 4000, "effort": "low", "timeout_ms": 90000, "budget_policy": "defer"}'::jsonb),
    (p_family, 'indexing_structure', 'anthropic', 'claude-opus-5-5',
     '{"max_tokens": 32000, "effort": "medium", "timeout_ms": 240000, "budget_policy": "defer"}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_default_model_routes(uuid) from public;

-- Back-fill the new role for every family that already exists (the function
-- above only fires for families created AFTER this migration; `on conflict
-- do nothing` makes re-running this safe and idempotent for both old and new
-- families).
select app_private.seed_default_model_routes(f.id) from public.families f;

-- search_chunks (S1, ADR-008/ADR-032): a `ready_partial` book's READY
-- sections/chunks are just as searchable as a fully `ready` book's — only
-- the still-failing section's chunks are unstructured (section_id/topic_id
-- null there), which `assign_chunk_structure` already leaves untouched.
create or replace function public.search_chunks(
  p_family_id        uuid,
  p_query_text       text,
  p_tsquery          text,
  p_query_embedding  halfvec(1536) default null,
  p_subject_id       uuid default null,
  p_kind             text default null,
  p_material_id      uuid default null,
  p_limit            integer default 10
)
returns table (
  chunk_id        uuid,
  material_id     uuid,
  material_name   text,
  material_title  text,
  material_kind   text,
  subject_id      uuid,
  topic_id        uuid,
  topic_title     text,
  section_title   text,
  page            integer,
  locator         text,
  snippet         text,
  score           double precision,
  vector_rank     integer,
  text_rank       integer
)
language sql
stable
set search_path = public, extensions, pg_catalog
as $$
  with q as (
    select case when coalesce(p_tsquery, '') = '' then null
                else to_tsquery('simple'::regconfig, p_tsquery) end as tsq
  ),
  base as (
    select c.id, c.embedding, c.tsv, c.text
      from public.chunks c
      join public.materials m on m.id = c.material_id
     where c.owner_family_id = p_family_id
       and m.owner_family_id = p_family_id
       and m.status in ('ready', 'ready_partial')
       and m.use_in_lessons
       and (p_subject_id is null or m.subject_id = p_subject_id
            or exists (select 1 from public.material_topic_links l join public.topics t on t.id = l.topic_id
                        where l.material_id = m.id and t.subject_id = p_subject_id))
       and (p_kind is null or m.kind = p_kind)
       and (p_material_id is null or m.id = p_material_id)
  ),
  vec as (
    select b.id, row_number() over (order by b.embedding <=> p_query_embedding)::integer as r
      from base b
     where p_query_embedding is not null and b.embedding is not null
     order by b.embedding <=> p_query_embedding
     limit 50
  ),
  txt as (
    select b.id,
           row_number() over (
             order by coalesce(ts_rank(b.tsv, q.tsq), 0) + word_similarity(p_query_text, b.text) desc
           )::integer as r
      from base b, q
     where coalesce(p_query_text, '') <> ''
       and ((q.tsq is not null and b.tsv @@ q.tsq) or p_query_text <% b.text)
     order by coalesce(ts_rank(b.tsv, q.tsq), 0) + word_similarity(p_query_text, b.text) desc
     limit 50
  ),
  fused as (
    select coalesce(v.id, t.id) as id,
           coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + t.r), 0) as score,
           v.r as vector_rank, t.r as text_rank
      from vec v full outer join txt t on t.id = v.id
  )
  select c.id, m.id, m.name, m.title, m.kind, m.subject_id, c.topic_id, tp.title, s.title,
         c.page, c.locator,
         case when q.tsq is not null and c.tsv @@ q.tsq
              then ts_headline('simple'::regconfig, c.text, q.tsq,
                               'StartSel="",StopSel="",MaxWords=45,MinWords=20,MaxFragments=1')
              else left(c.text, 320) end,
         f.score::double precision, f.vector_rank, f.text_rank
    from fused f
    join public.chunks c on c.id = f.id
    join public.materials m on m.id = c.material_id
    left join public.topics tp on tp.id = c.topic_id
    left join public.material_sections s on s.id = c.section_id
    cross join q
   order by f.score desc, c.ordinal
   limit greatest(1, least(p_limit, 50))
$$;
revoke all on function public.search_chunks(uuid, text, text, halfvec, uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.search_chunks(uuid, text, text, halfvec, uuid, text, uuid, integer)
  to service_role;
