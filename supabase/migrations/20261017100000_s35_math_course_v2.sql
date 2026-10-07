-- =============================================================================
-- S35 / Math course package v2 import (PO instruction 2026-10-07): a NEW,
-- FULL ($0, zero AI calls) import path for the real "Істер, математика 6
-- клас, частина 1" package — `public/course.json` (lessons, screens,
-- questions, quizzes, quiz_items, exercises, assets) + `private/
-- teacher.json` (question_keys, exercise_solutions, source_issues). See
-- `app/src/server/lessons/mathCourseV2Import.ts`'s header for the package's
-- own `IMPORT_CONTRACT.md`/schema files, read in full before this migration.
--
-- Why NEW tables, not reusing S34's `course_lessons`/`course_exercises`:
-- the S34 package (migration `20261016100000_s34_course_import.sql`) is
-- IMAGE-ANCHORED (theory/exercise text is only ever a cropped photo; OCR is
-- an unverified aid). This v2 package is the OPPOSITE: `display_md`/
-- `narration` are the finished, human-written, authoritative text for every
-- lesson screen, question and exercise — no page images/OCR anywhere in it
-- (the only images are 35 small supporting figures/diagrams, see
-- `course_v2_assets` below) — so the whole "authoritative_representation:
-- image" / `source_material` shape S34 is built around does not apply, and
-- forcing this package through those tables would mean inventing fake
-- image blocks for text that already has real, clean markdown. A second,
-- narrow schema tailored to THIS contract is cleaner than overloading one
-- the PO may still receive more image-anchored packages for (other
-- subjects) — see S34's own migration header for that still-live format.
--
-- Naming: `course_v2_*` (not `course_*`, not `course_packages_v2`) — keeps
-- every new table visually grouped together and distinct from both S34's
-- `course_*` tables and S31's unrelated `courses`-kind-of-`subjects`
-- concept (see S34 migration header for that collision warning, still
-- relevant here).
--
-- THE SECURITY-CRITICAL PART (explicit package contract, "Ключі не
-- передаються перед відповіддю" — IMPORT_CONTRACT.md line ~37): the three
-- "private" tables below (`course_v2_question_keys`,
-- `course_v2_exercise_solutions`, `course_v2_source_issues`) get RLS
-- enabled and NO select policy at all, for ANY role — not even "parent"
-- (deliberately stricter than S33/S34's existing private-ish data, which
-- the parent role CAN read for debugging). Only the service-role key
-- (`createServiceClient()`, used exclusively from
-- `app/src/app/actions/math-course-v2.ts`'s two server actions, after
-- `requireChild()`/`requireParentAccess()`) can read them at all, since
-- service-role queries bypass RLS entirely. This is what makes the new
-- `submitQuestionAnswerAction`/`revealExerciseSolutionAction` actions the
-- ONLY way to ever see a `correct_option_id` or a solution step — unlike
-- the existing S33/S34 `LiteratureTest` path, which bakes
-- `correct_option_id` straight into the server-rendered props the CLIENT
-- component receives (see `CourseLessonView.tsx`'s `toLiteratureTestQuestions`
-- — a real, pre-existing exposure, documented but NOT changed in this
-- migration; see the handback report for why).
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- ON CONFLICT DO NOTHING everywhere). Requires S0, S1, S34 migrations
-- (reuses the `course_assets` Storage bucket S34 already created).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- One row per imported package (manifest.json's own `course.id`).
-- ---------------------------------------------------------------------------
create table if not exists public.course_v2_packages (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  subject_id         uuid not null references public.subjects (id) on delete cascade,
  package_key        text not null check (char_length(package_key) between 1 and 200), -- course.id, e.g. "ister_2023_math6_part1_v2"
  title              text not null check (char_length(title) between 1 and 300),
  language           text not null default 'uk',
  grade              smallint check (grade between 1 and 12),
  part               smallint,
  content_revision   text,
  source_file_name   text,
  source_sha256      text,
  counts             jsonb not null default '{}'::jsonb,
  status             text not null default 'active' check (status in ('active', 'error')),
  last_import_errors   jsonb not null default '[]'::jsonb,
  last_import_warnings jsonb not null default '[]'::jsonb,
  imported_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (owner_family_id, package_key)
);
create index if not exists course_v2_packages_owner_idx on public.course_v2_packages (owner_family_id);
drop trigger if exists course_v2_packages_touch on public.course_v2_packages;
create trigger course_v2_packages_touch before update on public.course_v2_packages
  for each row execute function app_private.touch_updated_at();

-- One row per figure/diagram actually uploaded to the `course_assets`
-- bucket (storage_path prefixed `v2/{package_id}/...` to never collide
-- with S34's own paths in the same bucket). PO correction 2026-10-07:
-- several of these are NOT decorative — some ARE the exercise's condition
-- (asset_ids on an exercise), and the "ray_"/"blank" ones are printable
-- construction templates with a real physical scale (same
-- `measurementWarning` idea as S34's `course_package_assets`).
create table if not exists public.course_v2_assets (
  id                     uuid primary key default gen_random_uuid(),
  owner_family_id        uuid references public.families (id) on delete cascade,
  package_id             uuid not null references public.course_v2_packages (id) on delete cascade,
  asset_key              text not null, -- package's own asset id, e.g. "figure_03", "p03_ex_193_ray_blank"
  storage_path           text not null,
  mime_type              text not null default 'image/webp',
  alt                    text not null default '',
  printed_page           integer,
  pdf_page               integer,
  width_px               integer,
  height_px              integer,
  physical_width_mm      numeric,
  physical_height_mm     numeric,
  scale_px_per_pdf_point numeric,
  -- true for any asset_key containing "_ray_"/"ray_"/"_blank"/"blank_" —
  -- a printable construction template, not an illustration (see
  -- `mathCourseV2Import.ts`'s `isConstructionTemplateAsset`).
  is_construction_template boolean not null default false,
  created_at             timestamptz not null default now(),
  unique (package_id, asset_key)
);
create index if not exists course_v2_assets_owner_idx on public.course_v2_assets (owner_family_id);
create index if not exists course_v2_assets_package_idx on public.course_v2_assets (package_id);

-- One row per `public.lessons[]` entry.
create table if not exists public.course_v2_lessons (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.course_v2_packages (id) on delete cascade,
  subject_id         uuid not null references public.subjects (id) on delete cascade,
  topic_id           uuid references public.topics (id) on delete set null,
  lesson_key         text not null check (char_length(lesson_key) between 1 and 100),
  order_no           integer not null,
  kind               text not null check (kind in ('lesson', 'review', 'assessment')),
  title              text not null check (char_length(title) between 1 and 300),
  objectives         jsonb not null default '[]'::jsonb,
  prerequisites      jsonb not null default '[]'::jsonb,
  printed_page_from  integer,
  printed_page_to    integer,
  screen_ids         jsonb not null default '[]'::jsonb,
  exercise_ids       jsonb not null default '[]'::jsonb,
  guided_practice_question_ids jsonb not null default '[]'::jsonb,
  quiz_id            text,
  status             text not null default 'active' check (status in ('active', 'needs_review')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (package_id, lesson_key)
);
create index if not exists course_v2_lessons_owner_idx on public.course_v2_lessons (owner_family_id);
create index if not exists course_v2_lessons_package_idx on public.course_v2_lessons (package_id, order_no);
create index if not exists course_v2_lessons_topic_idx on public.course_v2_lessons (topic_id);
drop trigger if exists course_v2_lessons_touch on public.course_v2_lessons;
create trigger course_v2_lessons_touch before update on public.course_v2_lessons
  for each row execute function app_private.touch_updated_at();

-- One row per `public.screens[]` entry — shown ONE AT A TIME by the child UI
-- (package contract: "подайте їх по одному"), ordered by order_no.
create table if not exists public.course_v2_screens (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  lesson_id          uuid not null references public.course_v2_lessons (id) on delete cascade,
  screen_key         text not null,
  order_no           integer not null,
  role               text not null default '',
  title              text not null default '',
  display_md         text not null default '',
  narration          text not null default '',
  pause_after        boolean not null default false,
  equations_latex    jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  unique (lesson_id, screen_key)
);
create index if not exists course_v2_screens_owner_idx on public.course_v2_screens (owner_family_id);
create index if not exists course_v2_screens_lesson_idx on public.course_v2_screens (lesson_id, order_no);

-- One row per `public.questions[]` entry (guided-practice / quiz question).
-- NEVER carries `correct_option_id` — that lives only in
-- `course_v2_question_keys` below.
create table if not exists public.course_v2_questions (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  lesson_id          uuid not null references public.course_v2_lessons (id) on delete cascade,
  question_key       text not null,
  max_points         integer not null default 1,
  display_md         text not null default '',
  narration          text not null default '',
  -- [{"id":"A","display_md":"...","narration":"..."}, ...] — no correctness here.
  options            jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  unique (lesson_id, question_key)
);
create index if not exists course_v2_questions_owner_idx on public.course_v2_questions (owner_family_id);
create index if not exists course_v2_questions_lesson_idx on public.course_v2_questions (lesson_id);
comment on table public.course_v2_questions is
  'Public/child-safe half of a question. The correct option id, hint, explanation and per-option feedback live ONLY in course_v2_question_keys (no select grant to any client role — service role only, read exclusively from submitQuestionAnswerAction AFTER the child has already answered).';

-- One row per `private.question_keys[]` entry. RLS below grants NO select
-- to any client role at all (see migration header).
create table if not exists public.course_v2_question_keys (
  id                     uuid primary key default gen_random_uuid(),
  owner_family_id        uuid references public.families (id) on delete cascade,
  question_id            uuid not null references public.course_v2_questions (id) on delete cascade,
  correct_option_id      text not null,
  hint                   text not null default '',
  hint_narration         text not null default '',
  explanation_md         text not null default '',
  explanation_narration  text not null default '',
  option_feedback        jsonb not null default '[]'::jsonb, -- [{"id":"A","feedback":"...","feedback_narration":"..."}]
  equations_latex        jsonb not null default '[]'::jsonb,
  certificate            jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  unique (question_id)
);
create index if not exists course_v2_question_keys_owner_idx on public.course_v2_question_keys (owner_family_id);

-- One row per `public.quizzes[]` entry.
create table if not exists public.course_v2_quizzes (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  lesson_id          uuid not null references public.course_v2_lessons (id) on delete cascade,
  quiz_key           text not null,
  title              text not null default '',
  question_count     integer not null default 0,
  max_points         integer not null default 0,
  mastery_threshold  numeric not null default 0.8,
  scoring            text not null default '',
  created_at         timestamptz not null default now(),
  unique (lesson_id, quiz_key)
);
create index if not exists course_v2_quizzes_owner_idx on public.course_v2_quizzes (owner_family_id);

-- One row per `public.quiz_items[]` entry — links a quiz to its ordered questions.
create table if not exists public.course_v2_quiz_items (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  quiz_id            uuid not null references public.course_v2_quizzes (id) on delete cascade,
  question_id        uuid not null references public.course_v2_questions (id) on delete cascade,
  order_no           integer not null,
  max_points         integer not null default 1,
  created_at         timestamptz not null default now(),
  unique (quiz_id, question_id)
);
create index if not exists course_v2_quiz_items_owner_idx on public.course_v2_quiz_items (owner_family_id);
create index if not exists course_v2_quiz_items_quiz_idx on public.course_v2_quiz_items (quiz_id, order_no);

-- One row per `public.exercises[]` entry — original numbered textbook
-- exercise, reference material (never auto-graded; grading_mode from the
-- package is kept verbatim for the tutor prompt, e.g. "tutor_review",
-- "source_issue_review"). NEVER carries a solution — see
-- `course_v2_exercise_solutions` below.
create table if not exists public.course_v2_exercises (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  package_id         uuid not null references public.course_v2_packages (id) on delete cascade,
  lesson_id          uuid references public.course_v2_lessons (id) on delete cascade,
  exercise_key       text not null,
  original_number    text not null,
  origin             text not null default 'textbook',
  display_md         text not null default '',
  narration          text not null default '',
  asset_ids          jsonb not null default '[]'::jsonb, -- package's own asset ids (course_v2_assets.asset_key), e.g. ["figure_03"]
  status             text not null default '',
  grading_mode       text not null default '',
  -- true when this exercise's own asset_ids include a construction
  -- template (course_v2_assets.is_construction_template) — PO correction
  -- 2026-10-07: show the same physical-scale warning as S34's
  -- `measurementWarning` for these.
  has_construction_template boolean not null default false,
  -- true when `course_v2_source_issues` has a row for this exercise — a
  -- FLAG only (never the issue text itself, which stays server-only/tutor-
  -- only, same spirit as never exposing a correct_option_id).
  has_source_issue   boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (package_id, exercise_key)
);
create index if not exists course_v2_exercises_owner_idx on public.course_v2_exercises (owner_family_id);
create index if not exists course_v2_exercises_lesson_idx on public.course_v2_exercises (lesson_id);

-- One row per `private.exercise_solutions[]` entry. RLS below grants NO
-- select to any client role at all (see migration header) — read only via
-- `revealExerciseSolutionAction` (service role).
create table if not exists public.course_v2_exercise_solutions (
  id                   uuid primary key default gen_random_uuid(),
  owner_family_id      uuid references public.families (id) on delete cascade,
  exercise_id          uuid not null references public.course_v2_exercises (id) on delete cascade,
  hint                 text not null default '',
  verification_note    text not null default '',
  status               text not null default '',
  -- [{"label":"1","steps_md":[...],"steps_narration":[...],"answer_md":"...","answer_narration":"...","equations_latex":[...],"certificate":{...}}, ...]
  parts                jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now(),
  unique (exercise_id)
);
create index if not exists course_v2_exercise_solutions_owner_idx on public.course_v2_exercise_solutions (owner_family_id);

-- One row per `private.source_issues[]` entry (16 in the real package) —
-- RLS below grants NO select to any client role. Read only from
-- `revealExerciseSolutionAction`, which folds the warning text into its
-- response alongside the solution (both are "after you've tried/asked"
-- content per the package's own tutor_policy).
create table if not exists public.course_v2_source_issues (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  exercise_id        uuid not null references public.course_v2_exercises (id) on delete cascade,
  issue              jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (exercise_id)
);
create index if not exists course_v2_source_issues_owner_idx on public.course_v2_source_issues (owner_family_id);

-- Progress (best-effort — "simple", per the brief): one row per answered
-- question. Not required for correctness (the verdict is always computed
-- fresh server-side), purely for a future "скільки вже зроблено" view.
create table if not exists public.course_v2_question_attempts (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  question_id        uuid not null references public.course_v2_questions (id) on delete cascade,
  selected_option_id text not null,
  is_correct         boolean not null,
  created_at         timestamptz not null default now()
);
create index if not exists course_v2_question_attempts_owner_idx on public.course_v2_question_attempts (owner_family_id);
create index if not exists course_v2_question_attempts_question_idx on public.course_v2_question_attempts (question_id);

-- TTS narration cache (same 4-column pattern as `20261015100000_tts_narration_cache.sql`,
-- applied to every table whose row carries narratable text this feature's
-- player can be asked to read aloud). PO request 2026-10-02/07: a
-- "🔊 Слухати" button per screen/exercise/explanation, child-triggered only
-- (NEVER autoplay).
alter table public.course_v2_screens
  add column if not exists narration_text_hash text,
  add column if not exists narration_audio_base64 text,
  add column if not exists narration_audio_mime text,
  add column if not exists narration_cached_at timestamptz;

alter table public.course_v2_exercises
  add column if not exists narration_text_hash text,
  add column if not exists narration_audio_base64 text,
  add column if not exists narration_audio_mime text,
  add column if not exists narration_cached_at timestamptz;

-- Question narration cache lives keyed by (question_id, hash) rather than on
-- the question row itself: the SAME question can need narration for its own
-- prompt AND (after answering) for the key's hint/explanation/option
-- feedback, which live on a DIFFERENT (private) table/row. A single shared
-- cache table keyed by an explicit `field` name avoids adding narration
-- columns to the private key table (kept maximally narrow) while still
-- caching every narratable field uniformly.
create table if not exists public.course_v2_narration_cache (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  ref_table          text not null,
  ref_id             uuid not null,
  field              text not null,
  text_hash          text not null,
  audio_base64       text not null,
  audio_mime         text not null default 'audio/mpeg',
  cached_at          timestamptz not null default now(),
  unique (ref_table, ref_id, field)
);
create index if not exists course_v2_narration_cache_owner_idx on public.course_v2_narration_cache (owner_family_id);
comment on table public.course_v2_narration_cache is
  'Generic TTS audio cache for course_v2 fields that do not have their own 4-column cache (question prompts, question_key hint/explanation/option feedback, exercise_solution steps/answers) — see narrateMathCourseV2Action.';

alter table public.course_v2_packages enable row level security;
alter table public.course_v2_assets enable row level security;
alter table public.course_v2_lessons enable row level security;
alter table public.course_v2_screens enable row level security;
alter table public.course_v2_questions enable row level security;
alter table public.course_v2_quizzes enable row level security;
alter table public.course_v2_quiz_items enable row level security;
alter table public.course_v2_exercises enable row level security;
alter table public.course_v2_question_attempts enable row level security;
alter table public.course_v2_narration_cache enable row level security;
-- Private, server-only tables — RLS enabled, NO select policy for anyone below.
alter table public.course_v2_question_keys enable row level security;
alter table public.course_v2_exercise_solutions enable row level security;
alter table public.course_v2_source_issues enable row level security;

-- Public-ish tables: parent full read; child read only through an `active`
-- lesson (same shape as S34). No client-side INSERT/UPDATE/DELETE anywhere
-- — only the service-role import pipeline and the two server actions write.
do $$
declare
  t text;
begin
  foreach t in array array['course_v2_packages', 'course_v2_assets', 'course_v2_lessons', 'course_v2_screens', 'course_v2_questions', 'course_v2_quizzes', 'course_v2_quiz_items', 'course_v2_exercises']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_parent', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'owner_family_id = (select public.app_family_id()) and (select public.app_role()) = ''parent'')',
      t || '_select_parent', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
  -- Private tables: revoke everything from anon/authenticated, no policy at
  -- all — service role (bypasses RLS) is the only reader.
  foreach t in array array['course_v2_question_keys', 'course_v2_exercise_solutions', 'course_v2_source_issues']
  loop
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end
$$;

drop policy if exists course_v2_lessons_select_child on public.course_v2_lessons;
create policy course_v2_lessons_select_child on public.course_v2_lessons
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and status = 'active'
  );

drop policy if exists course_v2_screens_select_child on public.course_v2_screens;
create policy course_v2_screens_select_child on public.course_v2_screens
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.course_v2_lessons l where l.id = course_v2_screens.lesson_id and l.status = 'active')
  );

drop policy if exists course_v2_questions_select_child on public.course_v2_questions;
create policy course_v2_questions_select_child on public.course_v2_questions
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.course_v2_lessons l where l.id = course_v2_questions.lesson_id and l.status = 'active')
  );

drop policy if exists course_v2_quizzes_select_child on public.course_v2_quizzes;
create policy course_v2_quizzes_select_child on public.course_v2_quizzes
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.course_v2_lessons l where l.id = course_v2_quizzes.lesson_id and l.status = 'active')
  );

drop policy if exists course_v2_quiz_items_select_child on public.course_v2_quiz_items;
create policy course_v2_quiz_items_select_child on public.course_v2_quiz_items
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.course_v2_quizzes q where q.id = course_v2_quiz_items.quiz_id)
  );

drop policy if exists course_v2_exercises_select_child on public.course_v2_exercises;
create policy course_v2_exercises_select_child on public.course_v2_exercises
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and (
      lesson_id is null
      or exists (select 1 from public.course_v2_lessons l where l.id = course_v2_exercises.lesson_id and l.status = 'active')
    )
  );

drop policy if exists course_v2_assets_select_child on public.course_v2_assets;
create policy course_v2_assets_select_child on public.course_v2_assets
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.course_v2_lessons l where l.package_id = course_v2_assets.package_id and l.status = 'active')
  );

-- Attempts/narration cache: child can insert/select their own family's
-- rows directly (simple progress log, no answer-key content involved —
-- `is_correct` is a verdict already computed server-side before the insert,
-- never a key the child could read back to cheat with).
drop policy if exists course_v2_question_attempts_rw_child on public.course_v2_question_attempts;
create policy course_v2_question_attempts_rw_child on public.course_v2_question_attempts
  for all to authenticated
  using (owner_family_id = (select public.app_family_id()))
  with check (owner_family_id = (select public.app_family_id()));
revoke all on public.course_v2_question_attempts from anon;

drop policy if exists course_v2_narration_cache_rw on public.course_v2_narration_cache;
create policy course_v2_narration_cache_rw on public.course_v2_narration_cache
  for all to authenticated
  using (owner_family_id = (select public.app_family_id()))
  with check (owner_family_id = (select public.app_family_id()));
revoke all on public.course_v2_narration_cache from anon;

-- Note: no model_routes seed — this importer makes ZERO AI calls (all lesson
-- text is already written). `passive_narration` (TTS) is the only paid call
-- this feature makes, via the ALREADY-seeded role from
-- `20261002100000_s5_lesson_nav_tts.sql`.
