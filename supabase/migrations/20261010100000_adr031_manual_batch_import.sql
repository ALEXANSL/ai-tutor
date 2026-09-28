-- =============================================================================
-- ADR-031 Part 3: batch multi-subject ZIP manual import.
--
-- One ZIP (e.g. from Google Drive "Мої книги") can contain several
-- subject-folders (`ukr_mova/`, `istoriia/`, …), each with its own
-- `index.json` + `pages.jsonl` — see the ADR for the full contract. Adds:
--  - `materials.format` gains `'manual'` (a subject-folder imported this way,
--    no `ingest.extract`/AI structuring — the parent already has clean text);
--  - `materials.source_subpath` — which folder of the ZIP a row came from
--    (`''` for every existing/ordinary PDF/EPUB row, unaffected);
--  - the old 1-file-1-`materials`-row unique constraint is replaced with one
--    that also includes `source_subpath`, because one ZIP (one
--    `drive_file_id`) now legitimately produces several `materials` rows;
--  - `manual_import_batches` — tracks one ZIP through "detected -> parsed/
--    previewed -> parent confirmed -> imported" (ADR-031 §3.8).
--
-- Safe to re-run in the Supabase SQL Editor.
-- Requires 20260926100100_s1_materials_search.sql (public.materials).
-- =============================================================================

-- materials.format: add 'manual' (ADR-031 Частина 1(Б) and Частина 3 both use
-- it; only Частина 3 — the batch ZIP path — is implemented by this app
-- version, but the column value is shared).
alter table public.materials drop constraint if exists materials_format_check;
alter table public.materials add constraint materials_format_check
  check (format in ('pdf', 'epub', 'manual'));

-- source_subpath: '' for an ordinary single-file book (today's default,
-- untouched); the ZIP's subject-folder slug (e.g. 'ukr_mova') for a row
-- produced by the batch manual-import commit.
alter table public.materials
  add column if not exists source_subpath text not null default '';
comment on column public.materials.source_subpath is
  'ADR-031 §3.6: which folder of a manual-import ZIP this row came from
   (materials.format = ''manual''). Empty string for every ordinary
   single-file PDF/EPUB book — never null, so the unique index below can use
   a plain UNIQUE instead of NULLS NOT DISTINCT on this column specifically.';

-- One ZIP (drive_file_id) can now produce several rows (one per confirmed
-- subject-folder) — the old "one Drive file = one book" constraint is
-- replaced with one that also distinguishes the subpath.
alter table public.materials drop constraint if exists materials_owner_family_id_drive_file_id_key;
create unique index if not exists materials_owner_drive_subpath_uidx
  on public.materials (owner_family_id, drive_file_id, source_subpath)
  nulls not distinct;

-- Tracks one ZIP from "seen in the Drive folder" through "parent confirmed
-- the per-folder subject mapping and committed" (ADR-031 §3.8). `plan` holds
-- the preview job's per-folder summary (counts, suggested subject mapping)
-- and, after commit, a short per-folder result report — never the parsed
-- book text itself (re-parsed from the ZIP again at commit time; keeps this
-- table small no matter how large the source ZIP is).
create table if not exists public.manual_import_batches (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid not null references public.families (id) on delete cascade,
  drive_file_id    text not null,
  name             text not null,
  drive_md5        text,
  status           text not null default 'pending_review'
                     check (status in ('pending_review', 'importing', 'done', 'error')),
  plan             jsonb not null default '{}'::jsonb,
  error_detail     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists manual_import_batches_owner_idx on public.manual_import_batches (owner_family_id);
create unique index if not exists manual_import_batches_owner_drive_uidx
  on public.manual_import_batches (owner_family_id, drive_file_id);
drop trigger if exists manual_import_batches_touch on public.manual_import_batches;
create trigger manual_import_batches_touch before update on public.manual_import_batches
  for each row execute function app_private.touch_updated_at();

-- RLS: parent-visible only (same pattern as materials/subjects); every write
-- goes through the server (service role) — drive.sync detects new ZIPs,
-- ingest.manual_batch_preview/ingest.manual_batch_commit do the rest.
alter table public.manual_import_batches enable row level security;
drop policy if exists manual_import_batches_select_parent on public.manual_import_batches;
create policy manual_import_batches_select_parent on public.manual_import_batches
  for select to authenticated
  using (owner_family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');
revoke all on public.manual_import_batches from anon;
revoke insert, update, delete, truncate on public.manual_import_batches from authenticated;
