-- =============================================================================
-- S1 / Materials ("Мої книги"), structure (sections -> topics -> pages),
-- text fragments with embeddings, hybrid search (pgvector + FTS + trigram).
--
-- Requirements: US-2.1…2.4, US-2.6 (KP-1, 2, 5, 6), US-2.7 (KP-1, 3, 4, 5),
-- NFR-PLAT-6, NFR-PLAT-7; docs/02 8.2, 9.1, 12; ADR-008, ADR-017, ADR-021.
-- Learning content carries nullable `owner_family_id` (NULL = shared in the
-- future; in the MVP everything is family-owned) — ADR-018 K-3.
--
-- Safe to re-run in the Supabase SQL Editor.
-- Requires 20260926100000_s1_ai_router_costs_jobs.sql (extensions).
-- =============================================================================

-- Books / materials from the Drive folder. `kind` is validated in code against
-- the source-type registry (ADR-017), so new types need no migration.
create table if not exists public.materials (
  id                   uuid primary key default gen_random_uuid(),
  owner_family_id      uuid references public.families (id) on delete cascade,
  drive_file_id        text not null,
  name                 text not null,
  mime                 text not null,
  format               text not null check (format in ('pdf', 'epub')),
  title                text,
  kind                 text not null default 'other' check (kind ~ '^[a-z][a-z0-9_]*$'),
  kind_manual          boolean not null default false,
  subject_id           uuid references public.subjects (id) on delete set null,
  subject_manual       boolean not null default false,
  topics_manual        boolean not null default false,
  use_in_lessons       boolean not null default true,
  status               text not null default 'queued'
                         check (status in ('queued', 'indexing', 'ready', 'error', 'scan_no_text',
                                           'deferred', 'removed')),
  status_detail        text,
  progress             jsonb not null default '{}'::jsonb,
  content_hash         text,
  drive_md5            text,
  drive_modified_time  timestamptz,
  size_bytes           bigint,
  page_count           integer,
  char_count           integer,
  -- Multi-year model (ADR-021): grade and curriculum are data, proposed by AI, editable.
  grade                smallint check (grade between 1 and 12),
  curriculum_version   text,
  edition_year         smallint,
  -- Origin / licence note (requirements 7.5, CR-4); set by the parent.
  provenance           text,
  added_at             timestamptz not null default now(),
  indexed_at           timestamptz,
  removed_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique nulls not distinct (owner_family_id, drive_file_id)
);
create index if not exists materials_owner_family_id_idx on public.materials (owner_family_id);
drop trigger if exists materials_touch on public.materials;
create trigger materials_touch before update on public.materials
  for each row execute function app_private.touch_updated_at();
comment on column public.materials.kind is
  'Source type key from the registry: textbook, literary_work, popular_science, reference, other, test_fragment (US-2.6 KP-1).';

-- Structure: sections / chapters (US-2.2). manual_override rows are never
-- overwritten by re-indexing (US-2.2 KP-2).
create table if not exists public.material_sections (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  material_id      uuid not null references public.materials (id) on delete cascade,
  title            text not null,
  page_from        integer,
  page_to          integer,
  sort_order       integer not null default 0,
  manual_override  boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists material_sections_material_idx on public.material_sections (material_id, sort_order);
create index if not exists material_sections_owner_idx on public.material_sections (owner_family_id);

-- Topics of a subject (for textbooks). Belong to a grade/curriculum (ADR-021).
create table if not exists public.topics (
  id                   uuid primary key default gen_random_uuid(),
  owner_family_id      uuid references public.families (id) on delete cascade,
  subject_id           uuid not null references public.subjects (id) on delete cascade,
  material_id          uuid references public.materials (id) on delete set null,
  section_id           uuid references public.material_sections (id) on delete set null,
  title                text not null check (char_length(title) between 1 and 300),
  page_from            integer,
  page_to              integer,
  sort_order           integer not null default 0,
  is_current           boolean not null default false,
  manual_override      boolean not null default false,
  grade                smallint check (grade between 1 and 12),
  curriculum_version   text,
  supersedes_topic_id  uuid references public.topics (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists topics_owner_idx on public.topics (owner_family_id);
create index if not exists topics_subject_idx on public.topics (subject_id, sort_order);
create index if not exists topics_material_idx on public.topics (material_id);
drop trigger if exists topics_touch on public.topics;
create trigger topics_touch before update on public.topics
  for each row execute function app_private.touch_updated_at();

create table if not exists public.topic_dependencies (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  topic_id         uuid not null references public.topics (id) on delete cascade,
  depends_on_id    uuid not null references public.topics (id) on delete cascade,
  source           text not null default 'ai' check (source in ('ai', 'parent')),
  created_at       timestamptz not null default now(),
  unique (topic_id, depends_on_id),
  check (topic_id <> depends_on_id)
);
create index if not exists topic_dependencies_owner_idx on public.topic_dependencies (owner_family_id);

-- Any book can be linked to topics (US-2.6 KP-1): AI proposes, parent corrects.
create table if not exists public.material_topic_links (
  owner_family_id  uuid references public.families (id) on delete cascade,
  material_id      uuid not null references public.materials (id) on delete cascade,
  topic_id         uuid not null references public.topics (id) on delete cascade,
  source           text not null default 'ai' check (source in ('ai', 'parent')),
  created_at       timestamptz not null default now(),
  primary key (material_id, topic_id)
);
create index if not exists material_topic_links_owner_idx on public.material_topic_links (owner_family_id);

-- Text fragments with page/locator, embedding and full-text vectors (ADR-008).
create table if not exists public.chunks (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  material_id      uuid not null references public.materials (id) on delete cascade,
  section_id       uuid references public.material_sections (id) on delete set null,
  topic_id         uuid references public.topics (id) on delete set null,
  ordinal          integer not null,
  -- PDF: page number; EPUB: chapter number (locator carries the chapter title).
  page             integer,
  locator          text,
  text             text not null,
  embedding        halfvec(1536),
  embedding_model  text,
  tsv              tsvector generated always as (to_tsvector('simple'::regconfig, text)) stored,
  created_at       timestamptz not null default now(),
  unique (material_id, ordinal)
);
create index if not exists chunks_owner_idx on public.chunks (owner_family_id);
create index if not exists chunks_topic_idx on public.chunks (topic_id);
create index if not exists chunks_unembedded_idx on public.chunks (material_id) where embedding is null;
create index if not exists chunks_embedding_hnsw on public.chunks using hnsw (embedding halfvec_cosine_ops);
create index if not exists chunks_tsv_gin on public.chunks using gin (tsv);
create index if not exists chunks_text_trgm on public.chunks using gin (text gin_trgm_ops);

-- Hybrid search (ADR-008): Reciprocal Rank Fusion of vector (cosine) and text
-- (tsvector 'simple' with prefix terms + pg_trgm word similarity) rankings.
-- Only usable books: status 'ready' and "use in lessons" on (US-2.6 KP-2).
-- Server-only (service role); the family is passed explicitly (forFamily).
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
       and m.status = 'ready'
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

-- Batch write of embeddings (server only): items = [{"id": uuid, "embedding": [..1536 floats..]}].
create or replace function public.set_chunk_embeddings(p_family_id uuid, p_model text, p_items jsonb)
returns integer
language sql
security definer
set search_path = public, extensions, pg_catalog
as $$
  with upd as (
    update public.chunks c
       set embedding = ((i.value -> 'embedding')::text)::halfvec(1536),
           embedding_model = p_model
      from jsonb_array_elements(p_items) i
     where c.id = (i.value ->> 'id')::uuid
       and c.owner_family_id = p_family_id
    returning c.id
  )
  select count(*)::integer from upd
$$;
revoke all on function public.set_chunk_embeddings(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_chunk_embeddings(uuid, text, jsonb) to service_role;

-- Links every fragment of a material to the narrowest section / topic whose
-- page range contains its page (after the structure step).
create or replace function public.assign_chunk_structure(p_family_id uuid, p_material_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with upd as (
    update public.chunks c
       set section_id = (
             select s.id from public.material_sections s
              where s.material_id = c.material_id and c.page between s.page_from and s.page_to
              order by s.page_to - s.page_from, s.sort_order limit 1),
           topic_id = (
             select t.id from public.topics t
              where t.material_id = c.material_id and c.page between t.page_from and t.page_to
              order by t.page_to - t.page_from, t.sort_order limit 1)
     where c.material_id = p_material_id and c.owner_family_id = p_family_id
    returning c.id
  )
  select count(*)::integer from upd
$$;
revoke all on function public.assign_chunk_structure(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_chunk_structure(uuid, uuid) to service_role;

-- RLS: in S1 all of this is visible to the parent only (the child's "Мої книги"
-- is US-2.7 KP-2, Should, S24). Writes: server only (service role).
alter table public.materials enable row level security;
alter table public.material_sections enable row level security;
alter table public.topics enable row level security;
alter table public.topic_dependencies enable row level security;
alter table public.material_topic_links enable row level security;
alter table public.chunks enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['materials', 'material_sections', 'topics', 'topic_dependencies',
                           'material_topic_links', 'chunks']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_parent', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'owner_family_id = (select public.app_family_id()) and (select public.app_role()) = ''parent'')',
      t || '_select_parent', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end
$$;
