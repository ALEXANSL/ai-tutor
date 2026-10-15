-- =============================================================================
-- S45 / "Українська література, 6 клас" (Калинич/Дячок, 2023) chapter-package
-- v2.0.0 import — E-31 (US-31.1…31.3), ADR-044 (`literature_v3_*` data model,
-- AR-29). PO self-prepared package (own ChatGPT project, 2026-10-14):
-- `public/course.json` (lessons, `flow[]`, tasks) + **new** `public/
-- readings.json` (works/items/biographies — the actual text of 37 works,
-- finally closing the gap S36's own migration comment left open) +
-- `private/teacher.json` (quiz keys + lesson guides) + `catalog/assets.json`
-- (illustrations + `lesson_pdf`, now an OBJECT `{items}`, not an array) +
-- `catalog/pages.json` (reverse page index, now also an object) +
-- `catalog/task_tables.json` (always empty in this package version).
--
-- Why NOT `literature_v2_*` (S36): that package's tasks are ALL open-
-- response (no correct option to hide); this package's tasks are
-- `single_choice` with `correct_option_ids`/`option_feedback` — the EXACT
-- contract `course_v2_questions`/`course_v2_question_keys` (S35, math)
-- already implements. Reusing `literature_v2_*` would be wrong (different
-- task contract); reusing the NAME `literature_v2_*` for a different
-- contract would be worse (confuses the still-active, unrelated S36
-- package). See ADR-044 §1/§3 for the full naming/reuse reasoning.
--
-- Why a NEW `literature_v3_*` family (not `literature_v2_*`, not literally
-- "v2.0.0"): `literature_v2_*` (S36) already names a different, still-active
-- package/contract; the package's OWN `schema_version: "2.0.0"` is the
-- content format's version, not our internal table-family number — our
-- family naming is one step ahead of that number already (S34 `course_*` →
-- S35 `course_v2_*`; S33 `literature_lessons` → S36 `literature_v2_*`), so
-- "the next, newer family of this subject's kind" is `literature_v3_*`.
--
-- QUIZZES ARE A LITERAL REUSE of `course_v2_questions`/
-- `course_v2_question_keys`/`course_v2_quizzes`/`course_v2_quiz_items` (S35)
-- — NOT a new table family. The only schema change those tables need is one
-- new, NULLABLE, backward-compatible column each
-- (`literature_v3_lesson_id`), guarded by a CHECK that exactly one of
-- `lesson_id`/`literature_v3_lesson_id` is set — existing math (S35) rows
-- are UNTOUCHED (this migration never UPDATEs an existing row, only ADDs a
-- column + constraint). `course_v2_question_keys`/`course_v2_quiz_items`/
-- `course_v2_question_attempts` need NO change at all — they key off
-- `question_id`/`quiz_id`, not the lesson's own table (ADR-044 §1,
-- AR-R24 regression risk — math regression tests MUST still pass after
-- this migration; see handback report).
--
-- `lesson_sessions.reading_position` (US-31.2 КП-2, ADR-044 §1): one new
-- nullable jsonb column on the EXISTING `lesson_sessions` table (S3) — the
-- offset is in Unicode CODE POINTS of `content.tts.text`, never a JS UTF-16
-- string index (`INTEGRATION.md`'s own explicit requirement) — enforced in
-- application code (`Array.from(text)`/`Intl.Segmenter`), not representable
-- as a DB constraint.
--
-- `catalog/task_tables.json` — NO table created (`items` is always empty in
-- this package version, "письмові таблиці замінено квізами" — the importer
-- validates and ignores the file; see `literatureV3Import.ts`'s header).
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- ON CONFLICT DO NOTHING everywhere). Requires S0, S1, S35 migrations
-- (reuses `course_v2_questions`/`course_v2_quizzes`/`course_v2_quiz_items`/
-- `course_v2_question_keys`/`course_v2_narration_cache` and S3's
-- `lesson_sessions`).
-- =============================================================================

create table if not exists public.literature_v3_packages (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  subject_id         uuid not null references public.subjects (id) on delete cascade,
  package_key        text not null check (char_length(package_key) between 1 and 200), -- package.json's book_id
  title              text not null check (char_length(title) between 1 and 300),
  language           text not null default 'uk',
  grade              smallint check (grade between 1 and 12),
  progress_namespace text not null default '',
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
create index if not exists literature_v3_packages_owner_idx on public.literature_v3_packages (owner_family_id);
drop trigger if exists literature_v3_packages_touch on public.literature_v3_packages;
create trigger literature_v3_packages_touch before update on public.literature_v3_packages
  for each row execute function app_private.touch_updated_at();

-- One row per `catalog/assets.json` item — BOTH illustrations
-- (`kind='textbook_illustration'`) AND the new per-lesson PDFs
-- (`kind='lesson_pdf'`, `page_map` — the basis of the future "virtual book"
-- reader, ADR-044 §4, NOT built in this slice). `storage_path` stays null
-- until the (optional, same upload call) assets zip actually contains that
-- file — same resilience contract as S35/S36's `persistAssets`.
create table if not exists public.literature_v3_assets (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v3_packages (id) on delete cascade,
  asset_key          text not null, -- package's own asset id, e.g. "...-A-p022-dara-kornii" or "...-L001-PDF"
  kind               text not null check (kind in ('textbook_illustration', 'lesson_pdf')),
  storage_path       text,
  mime_type          text not null default '',
  title              text not null default '', -- lesson_pdf only
  caption            text not null default '', -- textbook_illustration only
  alt                text not null default '',
  tts                jsonb not null default '{}'::jsonb,
  -- lesson_pdf only: [{page_id, printed_page, source_pdf_page, bundle_pdf_page}, ...], all numbered from 1.
  page_map           jsonb not null default '[]'::jsonb,
  byte_size          integer,
  sha256             text,
  created_at         timestamptz not null default now(),
  unique (package_id, asset_key)
);
create index if not exists literature_v3_assets_owner_idx on public.literature_v3_assets (owner_family_id);
create index if not exists literature_v3_assets_package_idx on public.literature_v3_assets (package_id);

-- One row per `public.lessons[]` entry (46 in the real package).
create table if not exists public.literature_v3_lessons (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v3_packages (id) on delete cascade,
  subject_id         uuid not null references public.subjects (id) on delete cascade,
  topic_id           uuid references public.topics (id) on delete set null,
  lesson_key         text not null check (char_length(lesson_key) between 1 and 100),
  order_no           integer not null,
  title              text not null check (char_length(title) between 1 and 300),
  estimated_minutes  integer,
  objectives         jsonb not null default '[]'::jsonb,
  prerequisites      jsonb not null default '[]'::jsonb,
  misconceptions     jsonb not null default '[]'::jsonb,
  -- Compatible-but-unused (ADR-044 §3): kept verbatim for a possible future
  -- search/chat use, NEVER rendered by the flow[]-based viewer.
  explanation        jsonb not null default '[]'::jsonb,
  definitions        jsonb not null default '[]'::jsonb,
  worked_example     jsonb,
  -- THE step order (ADR-044 §1): ordered array of {kind, ref_id},
  -- kind in ('screen','biography','reading','quiz') — rendered as-is by
  -- LiteratureV3LessonView, no separate "flow steps" table.
  flow               jsonb not null default '[]'::jsonb,
  page_bundle_asset_id text, -- literature_v3_assets.asset_key of this lesson's own lesson_pdf
  printed_page_from  integer,
  printed_page_to    integer,
  content_status     text not null default '',
  status             text not null default 'active' check (status in ('active', 'needs_review')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (package_id, lesson_key)
);
create index if not exists literature_v3_lessons_owner_idx on public.literature_v3_lessons (owner_family_id);
create index if not exists literature_v3_lessons_package_idx on public.literature_v3_lessons (package_id, order_no);
create index if not exists literature_v3_lessons_topic_idx on public.literature_v3_lessons (topic_id);
drop trigger if exists literature_v3_lessons_touch on public.literature_v3_lessons;
create trigger literature_v3_lessons_touch before update on public.literature_v3_lessons
  for each row execute function app_private.touch_updated_at();

-- One row per lesson `screens[]` entry — rendered for `flow[].kind='screen'`
-- steps, same "подайте їх по одному" convention as S35/S36.
create table if not exists public.literature_v3_screens (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  lesson_id          uuid not null references public.literature_v3_lessons (id) on delete cascade,
  screen_key         text not null,
  order_no           integer not null,
  step_type          text not null default '',
  title              text not null default '',
  content_display    text not null default '',
  content_tts        jsonb not null default '{}'::jsonb, -- {text, lang}
  tutor_action       text not null default '', -- service-only instruction, never narrated (INTEGRATION.md)
  asset_ids          jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  unique (lesson_id, screen_key)
);
create index if not exists literature_v3_screens_owner_idx on public.literature_v3_screens (owner_family_id);
create index if not exists literature_v3_screens_lesson_idx on public.literature_v3_screens (lesson_id, order_no);

-- One row per `readings.json`'s `works[]` entry (37 in the real package) —
-- the work itself (title/author/honest completeness label), not its text.
create table if not exists public.literature_v3_works (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v3_packages (id) on delete cascade,
  work_key           text not null,
  title              text not null check (char_length(title) between 1 and 300),
  author             text not null default '',
  form               text not null default '',
  scope              text not null default '', -- textbook_abridgment | textbook_excerpt | as_printed | textbook_section
  completeness       text not null default '', -- e.g. complete_textbook_selection — honest "complete AS PRINTED", not "complete original work"
  note               text not null default '',
  created_at         timestamptz not null default now(),
  unique (package_id, work_key)
);
create index if not exists literature_v3_works_owner_idx on public.literature_v3_works (owner_family_id);
create index if not exists literature_v3_works_package_idx on public.literature_v3_works (package_id);

-- One row per `readings.json`'s `items[]` entry (214 posторінкових
-- fragments in the real package) — rendered for `flow[].kind='reading'`
-- steps, in `sequence` order. THIS is the actual text of the work — the gap
-- S36's own migration comment explicitly left open ("The 290 individual
-- per-page PDFs... are NOT uploaded by this slice").
create table if not exists public.literature_v3_reading_items (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  work_id            uuid not null references public.literature_v3_works (id) on delete cascade,
  reading_key        text not null,
  sequence_no        integer not null,
  title              text not null default '',
  content_type       text not null default '',
  content_display    text not null default '',
  content_tts        jsonb not null default '{}'::jsonb, -- {text, lang} — the TTS/reading-position source text (INTEGRATION.md)
  primary_page_id    text,
  created_at         timestamptz not null default now(),
  unique (work_id, reading_key)
);
create index if not exists literature_v3_reading_items_owner_idx on public.literature_v3_reading_items (owner_family_id);
create index if not exists literature_v3_reading_items_work_idx on public.literature_v3_reading_items (work_id, sequence_no);

-- One row per `readings.json`'s `biographies[]` entry (26 in the real
-- package) — rendered for `flow[].kind='biography'` steps. Passive content,
-- never evaluated (US-31.2 КП-5).
create table if not exists public.literature_v3_biographies (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v3_packages (id) on delete cascade,
  biography_key      text not null,
  author_name        text not null check (char_length(author_name) between 1 and 200),
  origin             text not null default '',
  content_display    text not null default '',
  content_tts        jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (package_id, biography_key)
);
create index if not exists literature_v3_biographies_owner_idx on public.literature_v3_biographies (owner_family_id);
create index if not exists literature_v3_biographies_package_idx on public.literature_v3_biographies (package_id);

-- Reverse page index (`catalog/pages.json`) — "сторінка → який lesson_pdf-
-- асет її містить і яка сторінка всередині нього" (ADR-044 §1/§4). The ONLY
-- new infrastructure specific to the future "virtual book" reader — not
-- built in this slice (see handback report), but captured now so a future
-- slice needs no re-import.
create table if not exists public.literature_v3_pages (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.literature_v3_packages (id) on delete cascade,
  page_key           text not null, -- package's own page id, e.g. "...-P006"
  printed_page       integer not null,
  source_pdf_page    integer not null,
  -- [{lesson_key, pdf_asset_key, bundle_pdf_page}, ...] — which lesson(s)
  -- this page belongs to and where inside that lesson's own small PDF.
  lesson_locations   jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  unique (package_id, page_key)
);
create index if not exists literature_v3_pages_owner_idx on public.literature_v3_pages (owner_family_id);
create index if not exists literature_v3_pages_package_idx on public.literature_v3_pages (package_id, printed_page);

-- ---------------------------------------------------------------------------
-- Quizzes: LITERAL REUSE of course_v2_questions/course_v2_question_keys/
-- course_v2_quizzes/course_v2_quiz_items (S35) — see migration header.
-- ---------------------------------------------------------------------------

alter table public.course_v2_questions alter column lesson_id drop not null;
alter table public.course_v2_questions
  add column if not exists literature_v3_lesson_id uuid references public.literature_v3_lessons (id) on delete cascade;
alter table public.course_v2_questions drop constraint if exists course_v2_questions_exactly_one_lesson;
alter table public.course_v2_questions
  add constraint course_v2_questions_exactly_one_lesson check (num_nonnulls(lesson_id, literature_v3_lesson_id) = 1);
create unique index if not exists course_v2_questions_lit_v3_lesson_key_idx
  on public.course_v2_questions (literature_v3_lesson_id, question_key) where literature_v3_lesson_id is not null;
create index if not exists course_v2_questions_lit_v3_lesson_idx on public.course_v2_questions (literature_v3_lesson_id);

alter table public.course_v2_quizzes alter column lesson_id drop not null;
alter table public.course_v2_quizzes
  add column if not exists literature_v3_lesson_id uuid references public.literature_v3_lessons (id) on delete cascade;
alter table public.course_v2_quizzes drop constraint if exists course_v2_quizzes_exactly_one_lesson;
alter table public.course_v2_quizzes
  add constraint course_v2_quizzes_exactly_one_lesson check (num_nonnulls(lesson_id, literature_v3_lesson_id) = 1);
create unique index if not exists course_v2_quizzes_lit_v3_lesson_key_idx
  on public.course_v2_quizzes (literature_v3_lesson_id, quiz_key) where literature_v3_lesson_id is not null;
create index if not exists course_v2_quizzes_lit_v3_lesson_idx on public.course_v2_quizzes (literature_v3_lesson_id);

-- RLS: the existing child-select policies on course_v2_questions/
-- course_v2_quizzes gain an OR-branch for the new literature_v3_lesson_id
-- parent. course_v2_question_keys/course_v2_quiz_items/
-- course_v2_question_attempts/course_v2_narration_cache need NO change —
-- they key off question_id/quiz_id, which is already covered.
drop policy if exists course_v2_questions_select_child on public.course_v2_questions;
create policy course_v2_questions_select_child on public.course_v2_questions
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and (
      exists (select 1 from public.course_v2_lessons l where l.id = course_v2_questions.lesson_id and l.status = 'active')
      or exists (select 1 from public.literature_v3_lessons l where l.id = course_v2_questions.literature_v3_lesson_id and l.status = 'active')
    )
  );

drop policy if exists course_v2_quizzes_select_child on public.course_v2_quizzes;
create policy course_v2_quizzes_select_child on public.course_v2_quizzes
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and (
      exists (select 1 from public.course_v2_lessons l where l.id = course_v2_quizzes.lesson_id and l.status = 'active')
      or exists (select 1 from public.literature_v3_lessons l where l.id = course_v2_quizzes.literature_v3_lesson_id and l.status = 'active')
    )
  );

-- Parent full-read policies on course_v2_questions/course_v2_quizzes
-- already match on owner_family_id + role='parent' only (no lesson_id
-- involved) — no change needed there.

-- ---------------------------------------------------------------------------
-- Reading position (US-31.2 КП-2, ADR-044 §1): one new nullable column on
-- the EXISTING lesson_sessions table (S3) — NOT a new table, NOT
-- localStorage (see ADR-044 §1 for the full reasoning: continues the same
-- server-side "Продовжити" guarantee every other lesson step already has).
-- {kind:"reading", ref_id, offset_codepoints} — offset is in Unicode CODE
-- POINTS of content.tts.text, never a JS UTF-16 string index
-- (INTEGRATION.md's own explicit requirement; enforced in application code,
-- not representable as a DB constraint). Cleared once the session moves to
-- a non-reading step.
-- ---------------------------------------------------------------------------
alter table public.lesson_sessions add column if not exists reading_position jsonb;

alter table public.literature_v3_packages enable row level security;
alter table public.literature_v3_assets enable row level security;
alter table public.literature_v3_lessons enable row level security;
alter table public.literature_v3_screens enable row level security;
alter table public.literature_v3_works enable row level security;
alter table public.literature_v3_reading_items enable row level security;
alter table public.literature_v3_biographies enable row level security;
alter table public.literature_v3_pages enable row level security;

-- Public-ish tables: parent full read; child read only through an `active`
-- lesson. No client-side INSERT/UPDATE/DELETE anywhere — only the
-- service-role import pipeline writes.
do $$
declare
  t text;
begin
  foreach t in array array['literature_v3_packages', 'literature_v3_assets', 'literature_v3_lessons', 'literature_v3_screens', 'literature_v3_works', 'literature_v3_reading_items', 'literature_v3_biographies', 'literature_v3_pages']
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

drop policy if exists literature_v3_lessons_select_child on public.literature_v3_lessons;
create policy literature_v3_lessons_select_child on public.literature_v3_lessons
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and status = 'active'
  );

drop policy if exists literature_v3_screens_select_child on public.literature_v3_screens;
create policy literature_v3_screens_select_child on public.literature_v3_screens
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v3_lessons l where l.id = literature_v3_screens.lesson_id and l.status = 'active')
  );

-- Works/reading_items/biographies/assets/pages are package-scoped, not
-- lesson-scoped (a work can span lessons) — child can read any row whose
-- package has at least one active lesson, same "через active урок" spirit
-- as S36's own asset policy.
drop policy if exists literature_v3_works_select_child on public.literature_v3_works;
create policy literature_v3_works_select_child on public.literature_v3_works
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v3_lessons l where l.package_id = literature_v3_works.package_id and l.status = 'active')
  );

drop policy if exists literature_v3_reading_items_select_child on public.literature_v3_reading_items;
create policy literature_v3_reading_items_select_child on public.literature_v3_reading_items
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (
      select 1 from public.literature_v3_works w
      join public.literature_v3_lessons l on l.package_id = w.package_id
      where w.id = literature_v3_reading_items.work_id and l.status = 'active'
    )
  );

drop policy if exists literature_v3_biographies_select_child on public.literature_v3_biographies;
create policy literature_v3_biographies_select_child on public.literature_v3_biographies
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v3_lessons l where l.package_id = literature_v3_biographies.package_id and l.status = 'active')
  );

drop policy if exists literature_v3_assets_select_child on public.literature_v3_assets;
create policy literature_v3_assets_select_child on public.literature_v3_assets
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v3_lessons l where l.package_id = literature_v3_assets.package_id and l.status = 'active')
  );

drop policy if exists literature_v3_pages_select_child on public.literature_v3_pages;
create policy literature_v3_pages_select_child on public.literature_v3_pages
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.literature_v3_lessons l where l.package_id = literature_v3_pages.package_id and l.status = 'active')
  );

-- Note: no model_routes seed — this importer makes ZERO AI calls (every
-- lesson/reading/biography/task text is already written). TTS narration of
-- this content reuses the ALREADY-shared `course_v2_narration_cache` table
-- (its `ref_table`/`ref_id`/`field` key is plain text, not FK-constrained to
-- any specific table — see that table's own migration comment) — no new
-- cache table or model_routes row needed here.
