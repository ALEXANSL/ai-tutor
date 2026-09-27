-- S32 (E-23, US-23.1, D-105): "Інше" — nonschool materials without a
-- subject/course, and a chat scoped to one such material.
--
-- No new table for the "Інше" list itself (ВП-54): it is computed on the
-- fly from `materials` (kind <> 'textbook', status = 'ready',
-- use_in_lessons = true, subject_id is null, no `material_topic_links` row)
-- — see `server/materials/other.ts`. This migration only extends `chats` to
-- support a chat scoped to one material (КП-4), the same way it already
-- supports one scoped to a subject+topic ('subject_topic') or none
-- ('friend'/'private').
--
-- Idempotent: safe to re-run.

alter table public.chats drop constraint if exists chats_kind_check;
alter table public.chats
  add constraint chats_kind_check check (kind in ('subject_topic', 'friend', 'private', 'material'));

alter table public.chats
  add column if not exists material_id uuid references public.materials (id) on delete cascade;
create index if not exists chats_material_idx on public.chats (material_id) where material_id is not null;

-- The original `(kind = 'subject_topic') = (topic_id is not null)` table
-- check (unnamed, auto-named `chats_check`) is left untouched — it stays
-- satisfied for kind='material' rows (topic_id is null there too). This
-- adds the equivalent rule for the new kind, as its own named constraint so
-- it is safe to re-run regardless of the exact auto-generated name above.
alter table public.chats drop constraint if exists chats_material_id_check;
alter table public.chats
  add constraint chats_material_id_check check ((kind = 'material') = (material_id is not null));

-- One chat per child per material (mirrors chats_one_per_topic_idx).
create unique index if not exists chats_one_per_material_idx
  on public.chats (child_profile_id, material_id) where kind = 'material';

comment on column public.chats.material_id is
  'US-23.1 КП-4 (E-23): set only for kind=''material'' — a chat scoped to one
   nonschool material (no subject_id/topic_id), grounded only in that
   material''s own chunks, never mixed with another book/textbook.';
