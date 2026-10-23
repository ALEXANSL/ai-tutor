-- =============================================================================
-- S47 (PO decision 2026-10-27, Алекс): video lessons generated with Pictory
-- ("Параграф 16/17/18-19" з історії) — a SUPPLEMENT, not a replacement, to
-- whichever existing text-lesson system a topic already uses (literature /
-- course / math_v2 / literature_v2 / literature_v3, or none at all). Parent
-- picks a subject, then an existing topic by its own title (not a new
-- entity), then uploads the video file; the child sees a separate "🎬
-- Відео-урок" button next to whatever lesson button that topic already has.
--
-- One video per topic for now (re-uploading replaces it) — simplest shape
-- that fits "я спробую" with 3 ready files; see `video_lessons`' `unique
-- (topic_id)`.
--
-- Upload mechanism: same signed-upload-URL pattern as S34's
-- `course_import_staging` (not Drive — this is the app's own permanent
-- asset, like `course_assets`, not a family's book). Video files are much
-- bigger than the 10 MB/image `course_assets` ceiling, so this gets its own
-- bucket with a generous limit instead of widening that one.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / ON CONFLICT DO
-- NOTHING everywhere). Requires S0, S1 migrations (families, topics).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video_lessons', 'video_lessons', false, 524288000, array['video/mp4', 'video/webm', 'video/quicktime']) -- 500 MB ceiling
on conflict (id) do nothing;

create table if not exists public.video_lessons (
  id              uuid primary key default gen_random_uuid(),
  owner_family_id uuid references public.families (id) on delete cascade,
  subject_id      uuid not null references public.subjects (id) on delete cascade,
  topic_id        uuid not null references public.topics (id) on delete cascade,
  storage_path    text not null,
  mime_type       text not null default 'video/mp4',
  size_bytes      bigint not null default 0,
  created_at      timestamptz not null default now(),
  unique (topic_id)
);
create index if not exists video_lessons_owner_idx on public.video_lessons (owner_family_id);
create index if not exists video_lessons_subject_idx on public.video_lessons (subject_id);

alter table public.video_lessons enable row level security;

-- Only the service-role upload-complete action writes this table (same
-- shape as every other imported-content table in this app) — parent reads
-- for management, child reads to know a topic has a video to open.
drop policy if exists video_lessons_select_parent on public.video_lessons;
create policy video_lessons_select_parent on public.video_lessons
  for select to authenticated
  using (owner_family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

drop policy if exists video_lessons_select_child on public.video_lessons;
create policy video_lessons_select_child on public.video_lessons
  for select to authenticated
  using (owner_family_id = (select public.app_family_id()) and (select public.app_role()) = 'child');

revoke all on public.video_lessons from anon;
revoke insert, update, delete, truncate on public.video_lessons from authenticated;
