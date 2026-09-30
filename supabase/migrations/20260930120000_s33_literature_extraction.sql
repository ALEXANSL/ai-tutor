-- =============================================================================
-- S33 / Literature (and similar paragraph-structured subjects) whole-book
-- extraction — a SEPARATE, PARALLEL generation path from the pedagogical
-- pipeline (S3b, `runPedagogicalPipeline`). PO decision 2026-09-30, after the
-- pedagogical pipeline produced 4/4 failed blocks for Zarubizhna literatura
-- 6 klas: for subjects whose textbook is already organized into clear
-- paragraphs/topics (literature, history, ...), one (or a few, split by book
-- section — never by arbitrary character count) AI call per book section
-- extracts+lightly adapts the WHOLE topic straight from the indexed text —
-- short quotes from the work (never the full text — copyright, PO
-- correction 2026-09-30), textbook task/exercise numbering (paragraph,
-- page, task number) preserved verbatim — instead of the multi-pass
-- plan -> generate -> independent-reviewer -> revise loop.
--
-- Deliberately reuses `public.topics`/`public.materials` (ADR-018/ADR-021's
-- existing paragraph/topic model — no reason to duplicate it) but does NOT
-- reuse `library_items`/`library_steps`: that schema's step size limits
-- (`slide.textUk` <= 900 chars, no `multiple`/`truefalse`/`order` question
-- types) cannot hold this content shape or the PO's required test-question
-- shapes. `literature_lessons`/`literature_lesson_tests` below are new,
-- narrow tables for exactly this content shape. The COMPLETE text of a
-- literary work is deliberately never stored in THIS database (copyright)
-- — see `work_full_text_drive_file_id`'s comment below: it lives instead as
-- a small text file on the family's own Google Drive, fetched on demand.
--
-- Requirements: PO instruction 2026-09-30 (see docs/bugs — literature
-- pipeline failure), docs/02-architecture.md role table (7.3), ADR-005.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- ON CONFLICT DO NOTHING everywhere). Requires S0-S3b migrations.
-- =============================================================================

-- One row per course topic/paragraph-group (matches the PO's reference
-- `lessons/NN.md` — one file per topic, which itself may cover several
-- textbook sub-lessons, e.g. "Урок 5.1"/"Урок 5.2"). `topic_id` links to the
-- existing `public.topics` row for this same paragraph (created alongside
-- this row by the extraction pipeline, not by the old S1 structuring step,
-- since a literature book's chunk/topic auto-assignment is not run for this
-- path — see `literatureExtraction.ts`).
create table if not exists public.literature_lessons (
  id                   uuid primary key default gen_random_uuid(),
  owner_family_id      uuid references public.families (id) on delete cascade,
  subject_id           uuid not null references public.subjects (id) on delete cascade,
  material_id          uuid not null references public.materials (id) on delete cascade,
  topic_id             uuid references public.topics (id) on delete set null,
  topic_no             integer not null check (topic_no >= 1),
  section_title        text,
  title                text not null check (char_length(title) between 1 and 300),
  textbook_page_from    integer,
  textbook_page_to      integer,
  pdf_page_from         integer,
  pdf_page_to           integer,
  goal_uk              text not null default '',
  key_concepts         jsonb not null default '[]'::jsonb,
  explanation_md       text not null default '',
  -- Literary work covered by this topic, when any (a non-fiction/history
  -- topic simply leaves this null). PO correction 2026-09-30 (3rd/final):
  -- the work's COMPLETE text is deliberately NOT stored in THIS database
  -- (copyright risk — full reproduction of someone else's literary work,
  -- unlike a short quoted excerpt). `work_excerpts_uk` holds short
  -- citation-length quotes only. The complete text (already-recognized
  -- text the extraction pipeline sliced from the already-indexed `chunks`
  -- — never a fresh scan, never AI-regenerated) is written instead as a
  -- small text file on the FAMILY'S OWN Google Drive (the same `drive.file`
  -- OAuth grant already used for book uploads, ADR-024) —
  -- `work_full_text_drive_file_id` below is only that file's id, fetched
  -- on demand through a short in-memory TTL cache (`drive/workText.ts`),
  -- never cached here or in any other persistent store.
  work_title_uk               text,
  work_excerpts_uk            text,
  work_summary_uk             text,
  work_characters_uk          text,
  work_idea_uk                text,
  work_full_text_drive_file_id text,
  -- Sub-lessons within the topic (e.g. "5.1", "5.2"), each with its own
  -- verbatim-numbered textbook questions/homework:
  -- [{"no": "5.1", "titleUk": "...", "questionGroups": [{"labelUk": "Запитання і завдання", "page": 37, "pdfPage": 38, "items": [{"number": "1", "textUk": "..."}]}]}]
  sublessons           jsonb not null default '[]'::jsonb,
  teacher_note_uk       text not null default '',
  model                text,
  prompt_version       text,
  -- Deterministic content_qa result (ADR-034's completeness/encoding checks,
  -- reused) — no paid second-pass reviewer for this path (PO decision).
  content_qa           jsonb not null default '{}'::jsonb,
  status               text not null default 'active' check (status in ('active', 'needs_review')),
  sort_order            integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (material_id, topic_no)
);
create index if not exists literature_lessons_owner_idx on public.literature_lessons (owner_family_id);
create index if not exists literature_lessons_material_idx on public.literature_lessons (material_id, sort_order);
create index if not exists literature_lessons_subject_idx on public.literature_lessons (subject_id, sort_order);
drop trigger if exists literature_lessons_touch on public.literature_lessons;
create trigger literature_lessons_touch before update on public.literature_lessons
  for each row execute function app_private.touch_updated_at();
comment on column public.literature_lessons.work_excerpts_uk is
  'Short, citation-length quotes from the work only (PO correction 2026-09-30: never the full text — copyright). Null when the topic has no literary work (e.g. an introductory/theory-only topic).';
comment on column public.literature_lessons.work_full_text_drive_file_id is
  'PO correction 2026-09-30 (3rd/final): id of a small plain-text file on the family''s own Google Drive holding the work''s COMPLETE text — never stored in this database. Read on demand via drive/workText.ts (short in-memory TTL cache only). Null until that Drive write succeeds (e.g. Drive not yet connected) or when the topic has no literary work.';
comment on column public.literature_lessons.sublessons is
  'Per-sub-lesson (e.g. "5.1") textbook questions/homework with textbook numbering and page preserved verbatim — see column comment on the table.';

-- One test module per topic (matches the PO's reference `tests/NN.json`),
-- self-contained JSON — question types single/multiple/truefalse/match/
-- order/open, each with an explanation (PO instruction 2026-09-30).
create table if not exists public.literature_lesson_tests (
  id                uuid primary key default gen_random_uuid(),
  owner_family_id   uuid references public.families (id) on delete cascade,
  lesson_id         uuid not null references public.literature_lessons (id) on delete cascade,
  -- [{"id": "05-q1", "type": "single", "questionUk": "...", "options": [...], "answer": 0, "explanationUk": "..."}]
  questions         jsonb not null default '[]'::jsonb,
  model             text,
  created_at        timestamptz not null default now(),
  unique (lesson_id)
);
create index if not exists literature_lesson_tests_owner_idx on public.literature_lesson_tests (owner_family_id);
comment on table public.literature_lesson_tests is
  'One interactive test module per literature_lessons row (PO instruction 2026-09-30) — types single/multiple/truefalse/match/order/open, each question carries an explanationUk.';

alter table public.literature_lessons enable row level security;
alter table public.literature_lesson_tests enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['literature_lessons', 'literature_lesson_tests']
  loop
    -- Parent: full read (same shape as library_items_select_parent). Child:
    -- can read only `active` lessons (never `needs_review`) — mirrors
    -- library_items' child-visibility rule (S3).
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

drop policy if exists literature_lessons_select_child on public.literature_lessons;
create policy literature_lessons_select_child on public.literature_lessons
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and status = 'active'
  );

drop policy if exists literature_lesson_tests_select_child on public.literature_lesson_tests;
create policy literature_lesson_tests_select_child on public.literature_lesson_tests
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (
      select 1 from public.literature_lessons l
       where l.id = literature_lesson_tests.lesson_id and l.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- Model route: `literature_extraction` (Claude Opus — largest context window
-- of the two configured providers, needed to hold a whole book section
-- including a full literary work in one call). No `lesson_review`-style
-- independent-reviewer role here BY DESIGN (PO decision 2026-09-30): this is
-- extraction + light adaptation of existing text, not creative generation,
-- so only the cheap deterministic `content_qa` gate (reused from ADR-034,
-- code-side, no new role) runs after it.
-- ---------------------------------------------------------------------------
create or replace function app_private.seed_s33_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, escalation_provider, escalation_model, params)
  values
    (p_family, 'literature_extraction', 'anthropic', 'claude-opus-5-5', null, null,
     '{"max_tokens": 32000, "effort": "high", "timeout_ms": 600000}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_s33_model_routes(uuid) from public;

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
  perform app_private.seed_s5_model_routes(new.id);
  perform app_private.seed_s27_model_routes(new.id);
  perform app_private.seed_s33_model_routes(new.id);
  return new;
end;
$$;
-- Trigger already exists (same name, S1); no need to recreate it.

-- Existing families get the new role too.
select app_private.seed_s33_model_routes(f.id) from public.families f;
