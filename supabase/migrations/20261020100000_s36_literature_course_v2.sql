-- =============================================================================
-- S36 / Foreign-literature course package v2 import (PO upload 2026-10-08):
-- a NEW, parallel import path for "Зарубіжна література, 6 клас" (Літера
-- ЛТД, 2023) — `public/course.json` (lessons + tasks), `private/teacher.json`
-- (per-task hints/model-answer/criteria/misconceptions), `catalog/assets.json`
-- (illustrations) and `catalog/task_tables.json` (fill-in tables).
--
-- Why NOT `course_v2_*` (S35, math): that package's every task is a
-- multiple-choice/numeric question with ONE checkable correct answer
-- (`correct_option_id`/`certificate`). This package's 453 tasks are ALL
-- open-response (`auto_grade: false` on every single one, by the package's
-- own contract — see `literatureV2Import.ts`'s header) — there is no
-- correct option to hide, only a MODEL answer, grading criteria and a list
-- of common misconceptions with tutor guidance. Forcing that into
-- `course_v2_questions`' options/correct_option_id shape would be a lie
-- (no "correct" id exists); a second, narrow schema tailored to open-
-- response content is cleaner than bending S35's contract to fit a
-- fundamentally different task type.
--
-- Naming: `literature_v2_*` (S33's `literature_lessons`/`literature_lesson_
-- tests` is the OLDER, different extraction-pipeline format for a
-- paragraph-structured subject — see that migration's own header — so this
-- is explicitly versioned `_v2` to read as "the newer, PO-prepared-package
-- literature import", mirroring how S35 is `course_v2_*` relative to S34's
-- `course_*`).
--
-- THE SECURITY-CRITICAL PART (same shape as S35's migration, same
-- reasoning): `literature_v2_task_keys` (hints, model answer, grading
-- criteria, misconception guidance) gets RLS enabled and NO select policy
-- at all, for ANY role — service-role only, read exclusively through a
-- future `revealLiteratureV2TaskHelpAction`-style server action, mirroring
-- `course_v2_question_keys`'s "Ключі не передаються перед відповіддю" rule
-- (IMPORT_CONTRACT equivalent for this package, §7: "private/ і
-- demo/teacher.sqlite залишаються на сервері").
--
-- Each of the 53 lessons gets its own generic `public.topics` row, same
-- convention as S35 (one topic per lesson, created/updated by the persist
-- pipeline) — the package's OWN `catalog/topics.json` (the textbook's ~18
-- broader chapters, each spanning several lessons) is deliberately NOT
-- persisted as a separate entity in this slice: it does not map 1:1 onto
-- the single generic `topics` table every child-facing screen already
-- assumes (`SubjectTopicOption` expects exactly one lesson per topic card).
-- A "розділи" grouping header in the lessons list, if wanted later, can be
-- derived from page-range overlap without a schema change.
--
-- Scope of THIS migration/importer: structured lesson/task content +
-- illustrations (46 small images, uploaded the same way as S35's 35
-- figures). The 290 individual per-page PDFs/WebP previews/thumbnails
-- (`catalog/pages.json`) are NOT uploaded by this slice — `printed_page`/
-- `pdf_page` numbers are still captured on every task/lesson so a future
-- "Відкрити сторінку підручника" slice has everything it needs without a
-- re-import.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / ON CONFLICT DO
-- NOTHING everywhere). Requires S0, S1 migrations.
-- =============================================================================

create table if not exists public.literature_v2_packages (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  subject_id         uuid not null references public.subjects (id) on delete cascade,
  package_key        text not null check (char_length(package_key) between 1 and 200), -- course.json's book_id
  title              text not null check (char_length(title) between 1 and 300),
  language           text not null default 'uk',
  grade              smallint check (grade between 1 and 12),
  source_file_name   text,
  counts             jsonb not null default '{}'::jsonb,
  status             text not null default 'active' check (status in ('active', 'error')),
  last_import_errors   jsonb not null default '[]'::jsonb,
  last_import_warnings jsonb not null default '[]'::jsonb,
  imported_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (owner_family_id, package_key)
);
create index if not exists literature_v2_packages_owner_idx on public.literature_v2_packages (owner_family_id);
drop trigger if exists literature_v2_packages_touch on public.literature_v2_packages;
create trigger literature_v2_packages_touch before update on public.literature_v2_packages
  for each row execute function app_private.touch_updated_at();

-- One row per `catalog/assets.json` illustration. `storage_path` stays null
-- until the (optional, same upload call) illustrations zip actually
-- contains that file — same resilience contract as S35's `persistAssets`.
create table if not exists public.literature_v2_assets (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v2_packages (id) on delete cascade,
  asset_key          text not null, -- package's own illustration id, e.g. "zarlit6-...-ILL-010-0"
  page_id            text not null default '', -- package's own page id (P0xx) — no pages table yet, see migration header
  storage_path        text,
  mime_type           text not null default 'image/png',
  caption             text not null default '',
  alt                 text not null default '',
  tts                 jsonb not null default '{}'::jsonb,
  discussion_prompt    jsonb not null default '{}'::jsonb,
  printed_page         integer,
  pdf_page             integer,
  bbox_pdf_points      jsonb not null default '[]'::jsonb,
  rights               jsonb not null default '{}'::jsonb,
  sha256               text,
  created_at           timestamptz not null default now(),
  unique (package_id, asset_key)
);
create index if not exists literature_v2_assets_owner_idx on public.literature_v2_assets (owner_family_id);
create index if not exists literature_v2_assets_package_idx on public.literature_v2_assets (package_id);

-- One row per `public.lessons[]` entry (53).
create table if not exists public.literature_v2_lessons (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v2_packages (id) on delete cascade,
  subject_id         uuid not null references public.subjects (id) on delete cascade,
  topic_id           uuid references public.topics (id) on delete set null,
  lesson_key         text not null check (char_length(lesson_key) between 1 and 100),
  order_no           integer not null,
  title              text not null check (char_length(title) between 1 and 300),
  estimated_minutes  integer,
  objectives         jsonb not null default '[]'::jsonb,
  prerequisites      jsonb not null default '[]'::jsonb,
  explanation        jsonb not null default '[]'::jsonb, -- [{display, tts}, ...]
  definitions        jsonb not null default '[]'::jsonb, -- [{term, explanation:{display,tts}, origin}, ...]
  worked_example     jsonb, -- {origin, steps:[{display,tts}, ...]} | null
  misconceptions     jsonb not null default '[]'::jsonb, -- string[]
  task_ids           jsonb not null default '[]'::jsonb, -- ordered string[] — this lesson's own task rendering order
  practice_task_ids  jsonb not null default '[]'::jsonb,
  final_check_task_ids jsonb not null default '[]'::jsonb,
  primary_reading_pages jsonb not null default '[]'::jsonb, -- string[] page ids
  illustration_ids   jsonb not null default '[]'::jsonb, -- string[] asset keys
  printed_page_from  integer,
  printed_page_to    integer,
  content_status     text not null default '',
  status             text not null default 'active' check (status in ('active', 'needs_review')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (package_id, lesson_key)
);
create index if not exists literature_v2_lessons_owner_idx on public.literature_v2_lessons (owner_family_id);
create index if not exists literature_v2_lessons_package_idx on public.literature_v2_lessons (package_id, order_no);
create index if not exists literature_v2_lessons_topic_idx on public.literature_v2_lessons (topic_id);
drop trigger if exists literature_v2_lessons_touch on public.literature_v2_lessons;
create trigger literature_v2_lessons_touch before update on public.literature_v2_lessons
  for each row execute function app_private.touch_updated_at();

-- One row per lesson `screens[]` entry — shown one at a time by the (future)
-- child UI, same "подайте їх по одному" convention as S35.
create table if not exists public.literature_v2_screens (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  lesson_id          uuid not null references public.literature_v2_lessons (id) on delete cascade,
  screen_key         text not null,
  order_no           integer not null,
  step_type          text not null default '', -- opening | illustration | source | explanation | practice | reflection | ...
  content_display    text not null default '',
  content_tts        jsonb not null default '{}'::jsonb, -- {text, lang, segments?}
  tutor_action       text not null default '',
  asset_ids          jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  unique (lesson_id, screen_key)
);
create index if not exists literature_v2_screens_owner_idx on public.literature_v2_screens (owner_family_id);
create index if not exists literature_v2_screens_lesson_idx on public.literature_v2_screens (lesson_id, order_no);

-- One row per `public.tasks[]` entry (453) — public/child-safe half only.
-- NEVER carries hints/model-answer/criteria — those live ONLY in
-- `literature_v2_task_keys` below.
create table if not exists public.literature_v2_tasks (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v2_packages (id) on delete cascade,
  lesson_id          uuid not null references public.literature_v2_lessons (id) on delete cascade,
  task_key           text not null,
  original_label     text not null default '',
  prompt_display      text not null default '',
  prompt_tts          jsonb not null default '{}'::jsonb,
  subtasks            jsonb not null default '[]'::jsonb, -- [{id,label,display,tts}, ...]
  response_type        text not null default 'open',
  source               jsonb not null default '{}'::jsonb, -- {printed_page, pdf_page, page_id, rubric}
  asset_refs           jsonb not null default '[]'::jsonb,
  required_inputs       jsonb not null default '[]'::jsonb,
  printed_page          integer,
  pdf_page              integer,
  status                text not null default '',
  created_at            timestamptz not null default now(),
  unique (package_id, task_key)
);
create index if not exists literature_v2_tasks_owner_idx on public.literature_v2_tasks (owner_family_id);
create index if not exists literature_v2_tasks_lesson_idx on public.literature_v2_tasks (lesson_id);
comment on table public.literature_v2_tasks is
  'Public/child-safe half of an open-response task. Hints, model answer, grading criteria and misconception guidance live ONLY in literature_v2_task_keys (no select grant to any client role — service role only).';

-- One row per `private.items[]` entry (teacher.json). RLS below grants NO
-- select to any client role at all (see migration header).
create table if not exists public.literature_v2_task_keys (
  id                     uuid primary key default gen_random_uuid(),
  owner_family_id        uuid references public.families (id) on delete cascade,
  task_id                uuid not null references public.literature_v2_tasks (id) on delete cascade,
  hints                  jsonb not null default '[]'::jsonb, -- [{display,tts}, ...] — reveal one at a time
  solution_steps         jsonb not null default '[]'::jsonb,
  answer                 jsonb not null default '{}'::jsonb, -- {display,tts} — a POSSIBLE model answer, not the only correct one
  answer_kind            text not null default '',
  criteria               jsonb not null default '[]'::jsonb, -- [{criterion, met_feedback:{display,tts}, missing_feedback:{display,tts}}, ...]
  acceptable_alternatives jsonb not null default '[]'::jsonb,
  misconceptions         jsonb not null default '[]'::jsonb, -- [{student_pattern, feedback:{display,tts}, next_action:{display,tts}}, ...]
  created_at             timestamptz not null default now(),
  unique (task_id)
);
create index if not exists literature_v2_task_keys_owner_idx on public.literature_v2_task_keys (owner_family_id);

-- One row per `catalog/task_tables.json` entry (15) — fill-in-the-blanks
-- table for a task. Empty cells are always where the CHILD writes, never a
-- hidden answer (`empty_cells_are_student_input` from the package itself),
-- so this is public/child-safe like the task it belongs to.
create table if not exists public.literature_v2_task_tables (
  id                           uuid primary key default gen_random_uuid(),
  owner_family_id              uuid references public.families (id) on delete cascade,
  task_id                      uuid not null references public.literature_v2_tasks (id) on delete cascade,
  table_key                    text not null,
  columns                      jsonb not null default '[]'::jsonb,
  rows                         jsonb not null default '[]'::jsonb,
  source_pages                 jsonb not null default '[]'::jsonb,
  empty_cells_are_student_input boolean not null default true,
  origin                       text not null default '',
  created_at                   timestamptz not null default now(),
  unique (task_id)
);
create index if not exists literature_v2_task_tables_owner_idx on public.literature_v2_task_tables (owner_family_id);

alter table public.literature_v2_packages enable row level security;
alter table public.literature_v2_assets enable row level security;
alter table public.literature_v2_lessons enable row level security;
alter table public.literature_v2_screens enable row level security;
alter table public.literature_v2_tasks enable row level security;
alter table public.literature_v2_task_tables enable row level security;
-- Private, server-only table — RLS enabled, NO select policy for anyone below.
alter table public.literature_v2_task_keys enable row level security;

-- Public-ish tables: parent full read; child read only through an `active`
-- lesson. No client-side INSERT/UPDATE/DELETE anywhere — only the
-- service-role import pipeline (and, later, narration-cache-style actions)
-- write.
do $$
declare
  t text;
begin
  foreach t in array array['literature_v2_packages', 'literature_v2_assets', 'literature_v2_lessons', 'literature_v2_screens', 'literature_v2_tasks', 'literature_v2_task_tables']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_parent', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'owner_family_id = (select public.app_family_id()) and (select public.app_role()) = ''parent'')',
      t || '_select_parent', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
  execute format('revoke all on public.literature_v2_task_keys from anon, authenticated');
end
$$;

drop policy if exists literature_v2_lessons_select_child on public.literature_v2_lessons;
create policy literature_v2_lessons_select_child on public.literature_v2_lessons
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and status = 'active'
  );

drop policy if exists literature_v2_screens_select_child on public.literature_v2_screens;
create policy literature_v2_screens_select_child on public.literature_v2_screens
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v2_lessons l where l.id = literature_v2_screens.lesson_id and l.status = 'active')
  );

drop policy if exists literature_v2_tasks_select_child on public.literature_v2_tasks;
create policy literature_v2_tasks_select_child on public.literature_v2_tasks
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v2_lessons l where l.id = literature_v2_tasks.lesson_id and l.status = 'active')
  );

drop policy if exists literature_v2_task_tables_select_child on public.literature_v2_task_tables;
create policy literature_v2_task_tables_select_child on public.literature_v2_task_tables
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (
      select 1 from public.literature_v2_tasks tk
      join public.literature_v2_lessons l on l.id = tk.lesson_id
      where tk.id = literature_v2_task_tables.task_id and l.status = 'active'
    )
  );

drop policy if exists literature_v2_assets_select_child on public.literature_v2_assets;
create policy literature_v2_assets_select_child on public.literature_v2_assets
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v2_lessons l where l.package_id = literature_v2_assets.package_id and l.status = 'active')
  );

-- Note: no model_routes seed — this importer makes ZERO AI calls (every
-- lesson/task text is already written). TTS narration of this content, once
-- built, reuses the ALREADY-shared `course_v2_narration_cache` table (its
-- `ref_table`/`ref_id`/`field` key is plain text, not FK-constrained to any
-- specific course_v2_* table — see that table's own migration comment) and
-- the already-seeded `passive_narration` role from `20261002100000_s5_
-- lesson_nav_tts.sql` — no new cache table or model_routes row needed here.
