-- =============================================================================
-- S34 / Course package import (PO decision 2026-10-02, cost/trust crisis
-- after both `lesson_generation` and `literature_extraction` kept costing
-- real money without reliably producing usable lessons): "я готую повний
-- курс сам (через ChatGPT/Claude) і завантажую його архівом — ЖОДНИХ
-- викликів ШІ з нашого боку". A THIRD, PARALLEL, $0 import path — separate
-- from `literature_lessons`/`literatureImport.ts` (S33, plain text) and
-- from the old `library_items`/`pipeline.ts` (AI generation). This path is
-- IMAGE-ANCHORED: every piece of textbook content (theory, exercises) is
-- backed by a real cropped image of the scanned page, because OCR of math
-- (fractions, exponents, tables) is unreliable and must never be shown as
-- if it were the authoritative text (see `app/src/server/lessons/
-- __fixtures__/ister-math6-part1/README.md`, the package author's own
-- format description, read in full before writing this migration).
--
-- Architectural decision (not a rubber-stamp of the S33/Drive pattern):
-- the package's own author/PO designed this format to be copied into
-- "сховище додатка" (README.md, "Швидкий початок" §4) — unlike S33's
-- full-text-on-Drive copyright policy (short quotes only in the DB, full
-- text on the family's own Drive), these cropped page IMAGES are explicitly
-- meant to live in OUR storage, so this migration creates a new private
-- Supabase Storage bucket (`course_assets`) for them, resolved to
-- short-lived signed URLs server-side (never a public bucket, never a raw
-- URL stored anywhere) — see `app/src/server/lessons/courseView.ts`.
--
-- Naming: deliberately "course_package_*" (not "course_*") to avoid any
-- collision with the UNRELATED `courses`-kind-of-`subjects` / `course_groups`
-- concept introduced by S31 (`20261007100000_s31_subjects_courses.sql`) —
-- this feature has nothing to do with that one; a "course package" here is
-- simply the imported zip (one per textbook/part).
--
-- Deliberately NOT normalized further than the package's own JSON shapes:
-- `source_material`, `automatic_questions`, `content`, `source` etc. are
-- stored as `jsonb` as-is (matching how `literature_lessons`/
-- `literature_lesson_tests` already store similar nested shapes) — no
-- per-field columns for data that is only ever read back whole.
--
-- `course_lessons.topic_id` links to a `public.topics` row the IMPORT
-- PIPELINE creates alongside each lesson row (same pattern as
-- `literature_lessons.topic_id`, S33) — NOT the old S1 auto-structuring
-- step, which is never run for this path. This is what lets
-- `getSubjectDetail`/the child's `/subject/[id]` screen resolve a topic to
-- this lesson the same way it already does for a `literature_lessons` row.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- ON CONFLICT DO NOTHING everywhere). Requires S0, S1, S33 migrations.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Storage buckets.
--   course_import_staging — short-lived holding area for the zip itself: the
--     parent's browser PUTs the (possibly dozens-of-MB) zip here directly via
--     a signed upload URL (never through our Vercel function body, which has
--     a ~4.5 MB platform limit — same root cause as BUG-033's Drive-upload
--     fix, different mechanism because this file is never meant to live on
--     the family's Drive). The import action deletes the staged object once
--     it has parsed and persisted it (or failed with a reported error).
--   course_assets — the permanent home for every image the package ships
--     (theory/exercise fragments, figures, full pages). Private; the app
--     NEVER stores or returns a raw/public URL — only short-lived signed
--     URLs minted on demand by `courseView.ts`.
-- Both private (public = false): only the service role (our server, after
-- `requireParentAccess()`/`requireChild()`) ever reads or writes them.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('course_import_staging', 'course_import_staging', false, 314572800) -- 300 MB ceiling for the staged zip itself
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course_assets', 'course_assets', false, 10485760, array['image/webp', 'image/png', 'image/jpeg']) -- 10 MB/image ceiling
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- One row per imported package (manifest.json; one per textbook/part).
-- ---------------------------------------------------------------------------
create table if not exists public.course_packages (
  id                 uuid primary key default gen_random_uuid(),
  owner_family_id    uuid references public.families (id) on delete cascade,
  subject_id         uuid not null references public.subjects (id) on delete cascade,
  -- manifest.json's own `id` (e.g. "ister_2023_math6_part1") — stable key
  -- for idempotent re-import (re-uploading the same zip updates in place
  -- rather than duplicating).
  package_key        text not null check (char_length(package_key) between 1 and 200),
  schema_version     text not null default '1.0.0',
  title              text not null check (char_length(title) between 1 and 300),
  language           text not null default 'uk',
  source_file        text,
  source_sha256      text,
  grade              smallint check (grade between 1 and 12),
  part               smallint,
  counts             jsonb not null default '{}'::jsonb,
  quality_notes      jsonb not null default '[]'::jsonb,
  -- Import bookkeeping (BUG-prevention, PO: "не повторювати мовчазні
  -- провали" — every import leaves a full, specific record of what failed).
  status             text not null default 'active' check (status in ('active', 'error')),
  last_import_errors jsonb not null default '[]'::jsonb,
  last_import_warnings jsonb not null default '[]'::jsonb,
  imported_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (owner_family_id, package_key)
);
create index if not exists course_packages_owner_idx on public.course_packages (owner_family_id);
create index if not exists course_packages_subject_idx on public.course_packages (subject_id);
drop trigger if exists course_packages_touch on public.course_packages;
create trigger course_packages_touch before update on public.course_packages
  for each row execute function app_private.touch_updated_at();

-- One row per image the package ships that we actually copied into
-- `course_assets` storage (lazily — only assets referenced by at least one
-- imported lesson/exercise are uploaded; see `courseImport.ts`).
create table if not exists public.course_package_assets (
  id                     uuid primary key default gen_random_uuid(),
  owner_family_id        uuid references public.families (id) on delete cascade,
  package_id             uuid not null references public.course_packages (id) on delete cascade,
  asset_id               text not null,
  source_path            text not null, -- original path inside the zip, e.g. assets/fragments/p01_theory_p016.webp
  storage_path           text not null, -- path inside the `course_assets` bucket
  mime_type              text not null default 'image/webp',
  alt                    text,
  printed_page           integer,
  pdf_page               integer,
  bbox_pt                jsonb,
  width_px               integer,
  height_px              integer,
  physical_width_mm      numeric,
  physical_height_mm     numeric,
  scale_px_per_pdf_point numeric,
  created_at             timestamptz not null default now(),
  unique (package_id, asset_id)
);
create index if not exists course_package_assets_owner_idx on public.course_package_assets (owner_family_id);
create index if not exists course_package_assets_package_idx on public.course_package_assets (package_id);
comment on table public.course_package_assets is
  'Physical/scale metadata (physical_width_mm etc.) comes from assets/index.json when the package includes it (optional — see courseImport.ts); null when absent, never invented.';

-- One row per `lessons/*.json` (kind: lesson | review | assessment).
create table if not exists public.course_lessons (
  id                      uuid primary key default gen_random_uuid(),
  owner_family_id         uuid references public.families (id) on delete cascade,
  package_id              uuid not null references public.course_packages (id) on delete cascade,
  subject_id              uuid not null references public.subjects (id) on delete cascade,
  -- Created/kept in sync by the import pipeline (see migration header) —
  -- never by the old S1 auto-structuring step.
  topic_id                uuid references public.topics (id) on delete set null,
  lesson_key              text not null check (char_length(lesson_key) between 1 and 100), -- manifest's own id, e.g. "p01"
  order_no                integer not null,
  kind                    text not null check (kind in ('lesson', 'review', 'assessment')),
  title                   text not null check (char_length(title) between 1 and 300),
  grade                   smallint,
  part                    smallint,
  source                  jsonb not null default '{}'::jsonb, -- paragraph, printed_pages, pdf_pages, start, end_exclusive
  teacher_notes_md        text not null default '',
  teacher_notes_origin    text,
  -- [{"type":"source_image","asset_id":"p01_theory_p016","path":"assets/fragments/...","source":{...},"page_image_path":"...","search_text_ocr":"...","text_status":"unverified_ocr","authoritative_representation":"image"}, ...]
  source_material         jsonb not null default '[]'::jsonb,
  exercise_ids            jsonb not null default '[]'::jsonb,
  exercise_count          integer not null default 0,
  full_page_image_paths   jsonb not null default '[]'::jsonb,
  source_text_policy      text,
  status                  text not null default 'active' check (status in ('active', 'needs_review')),
  sort_order              integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (package_id, lesson_key)
);
create index if not exists course_lessons_owner_idx on public.course_lessons (owner_family_id);
create index if not exists course_lessons_package_idx on public.course_lessons (package_id, sort_order);
create index if not exists course_lessons_subject_idx on public.course_lessons (subject_id, sort_order);
create index if not exists course_lessons_topic_idx on public.course_lessons (topic_id);
drop trigger if exists course_lessons_touch on public.course_lessons;
create trigger course_lessons_touch before update on public.course_lessons
  for each row execute function app_private.touch_updated_at();
comment on column public.course_lessons.source_material is
  'Images are authoritative; OCR (search_text_ocr) is an unverified search aid only — never shown or graded as the condition text (package README §"Як збережено математику"). teacher_notes_md is a short adaptation, not a replacement.';
comment on column public.course_lessons.status is
  '"needs_review" when the import could not fully validate this lesson against the schema (missing required field etc.) — never silently dropped; see course_packages.last_import_errors/warnings for the specifics (PO: no more silent failures).';

-- One test module per lesson (tests/*.json) — fully text-based, auto-gradable.
create table if not exists public.course_lesson_tests (
  id                     uuid primary key default gen_random_uuid(),
  owner_family_id        uuid references public.families (id) on delete cascade,
  lesson_id              uuid not null references public.course_lessons (id) on delete cascade,
  test_key               text not null,
  title                  text not null default '',
  -- [{"id":"p01_q01","type":"single_choice","origin":"teacher_adaptation","prompt_md":"...","options":[{"id":"A","text_md":"..."}],"correct_option_id":"B","explanation_md":"...","max_points":1}, ...]
  automatic_questions    jsonb not null default '[]'::jsonb,
  automatic_max_points   integer not null default 0,
  source_exercise_ids    jsonb not null default '[]'::jsonb,
  source_keys_resource   text,
  grading_policy         text,
  created_at             timestamptz not null default now(),
  unique (lesson_id)
);
create index if not exists course_lesson_tests_owner_idx on public.course_lesson_tests (owner_family_id);
comment on table public.course_lesson_tests is
  'automatic_questions are single_choice/4-options/correct_option_id — the ONLY auto-graded part of this package (source exercises below are manual/tutor-reviewed reference material, per the package README).';

-- One row per original textbook exercise (exercises.jsonl) — reference
-- material only, NOT auto-graded (grading.mode = manual_or_tutor_review).
-- Persisted because `course_lessons.exercise_ids` references these ids, even
-- though rendering a full manual-grading UI for them is out of scope today
-- (see courseLessonView.ts / CourseLessonView.tsx doc comments).
create table if not exists public.course_exercises (
  id                   uuid primary key default gen_random_uuid(),
  owner_family_id      uuid references public.families (id) on delete cascade,
  package_id           uuid not null references public.course_packages (id) on delete cascade,
  lesson_id            uuid references public.course_lessons (id) on delete cascade,
  exercise_key         text not null, -- e.g. "p01_ex_092"
  origin               text not null default 'textbook',
  original_number      text not null, -- the number to SHOW the child, e.g. "797" — never the internal key
  source               jsonb not null default '{}'::jsonb,
  -- ordered array of {type:"source_image", path, asset_id, source, page_image_path, search_text_ocr, text_status, authoritative_representation}
  content              jsonb not null default '[]'::jsonb,
  figure_ids           jsonb not null default '[]'::jsonb,
  figure_paths         jsonb not null default '[]'::jsonb,
  search_text_ocr      text,
  text_status          text,
  response_type        text not null default 'open_response',
  grading              jsonb not null default '{"mode": "manual_or_tutor_review", "answer_key": null}'::jsonb,
  measurement_warning  boolean not null default false,
  created_at           timestamptz not null default now(),
  unique (package_id, exercise_key)
);
create index if not exists course_exercises_owner_idx on public.course_exercises (owner_family_id);
create index if not exists course_exercises_lesson_idx on public.course_exercises (lesson_id);
comment on table public.course_exercises is
  'Original numbered textbook exercises — manual/tutor-reviewed reference material (grading.mode always manual_or_tutor_review), NOT part of the auto-graded flow. A first pass renders these as a simple reference list only (see CourseLessonView.tsx).';

alter table public.course_packages enable row level security;
alter table public.course_package_assets enable row level security;
alter table public.course_lessons enable row level security;
alter table public.course_lesson_tests enable row level security;
alter table public.course_exercises enable row level security;

-- Parent: full read on every table (import management, debugging a failed
-- import). No INSERT/UPDATE/DELETE from the client at all — only the
-- service-role import pipeline writes these tables (mirrors
-- literature_lessons' grant shape exactly).
do $$
declare
  t text;
begin
  foreach t in array array['course_packages', 'course_package_assets', 'course_lessons', 'course_lesson_tests', 'course_exercises']
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

-- Child: only `active` lessons (never `needs_review`) — same rule as
-- literature_lessons_select_child (S33).
drop policy if exists course_lessons_select_child on public.course_lessons;
create policy course_lessons_select_child on public.course_lessons
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and status = 'active'
  );

drop policy if exists course_lesson_tests_select_child on public.course_lesson_tests;
create policy course_lesson_tests_select_child on public.course_lesson_tests
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (select 1 from public.course_lessons l where l.id = course_lesson_tests.lesson_id and l.status = 'active')
  );

drop policy if exists course_exercises_select_child on public.course_exercises;
create policy course_exercises_select_child on public.course_exercises
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and (
      lesson_id is null
      or exists (select 1 from public.course_lessons l where l.id = course_exercises.lesson_id and l.status = 'active')
    )
  );

drop policy if exists course_package_assets_select_child on public.course_package_assets;
create policy course_package_assets_select_child on public.course_package_assets
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'child'
    and exists (
      select 1 from public.course_lessons l
       where l.package_id = course_package_assets.package_id and l.status = 'active'
    )
  );

-- Note: no model_routes seed here — this path makes ZERO AI calls, by
-- explicit PO instruction (see migration header). Nothing to route.
