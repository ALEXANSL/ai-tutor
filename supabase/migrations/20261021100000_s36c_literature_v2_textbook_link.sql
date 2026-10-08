-- =============================================================================
-- PO feedback 2026-10-08: "де відкрити підручник? де пошук по підручнику,
-- зовсім обрізаний функціонал у порівнянні з математикою" — literature-v2
-- (S36) was missing the two features S35 (math-v2) already has:
-- "Відкрити підручник" (open the real textbook PDF at a given page) and a
-- search box over the imported lesson/task metadata. Both reuse existing,
-- generic machinery (`OpenTextbookPageButton`/`BookReader`, the same
-- `course_v2_narration_cache`-style pattern of one shared component per
-- feature) — this migration only adds the one piece S35's own
-- `20261019100000_s35_textbook_page_link.sql` added for math:
--
-- `literature_v2_packages.textbook_material_id` — which `materials` row
-- (the already-uploaded literature textbook PDF) this package's pages map
-- to. Nullable: the feature degrades to "no button" until linked, never
-- breaks anything. Set once via a direct SQL UPDATE, not a re-import.
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

alter table public.literature_v2_packages
  add column if not exists textbook_material_id uuid references public.materials (id) on delete set null;

-- -----------------------------------------------------------------------------
-- RUN THIS SEPARATELY, after confirming the material id (Алекс, виконай сам):
--
--   select id, title, name, format, page_count
--   from public.materials
--   where format = 'pdf' and name ilike '%заруб%літ%';
--
-- then, with that id:
--
--   update public.literature_v2_packages
--   set textbook_material_id = '<material id from the query above>';
-- -----------------------------------------------------------------------------
