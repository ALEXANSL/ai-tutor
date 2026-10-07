-- =============================================================================
-- PO request 2026-10-07: "біля задачі чи теми натискання на кнопку відкрити
-- підручник покаже конкретну сторінку підручника" — a modal that opens the
-- REAL textbook PDF (already-built reader at `/book/[materialId]`, which
-- works for any PDF `materials` row, not just literature) at a specific
-- page, next to a lesson or a single exercise.
--
-- Two additions:
-- 1. `course_v2_packages.textbook_material_id` — which `materials` row (the
--    actual uploaded PDF) this package's pages map to. Nullable: the
--    feature degrades to "no button" until linked, never breaks anything.
--    Set once via a direct SQL UPDATE (see below) — this is a one-time
--    metadata link, not new content, so it does not need a re-import.
-- 2. `course_v2_exercises.printed_page`/`pdf_page` — THIS exercise's own
--    page (not just the lesson's whole range), so the button opens the
--    exact page a specific problem is on, not just somewhere in a 9-page
--    review lesson. Backfilled by re-running the existing import (upsert,
--    safe to repeat).
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

alter table public.course_v2_packages
  add column if not exists textbook_material_id uuid references public.materials (id) on delete set null;

alter table public.course_v2_exercises
  add column if not exists printed_page integer,
  add column if not exists pdf_page integer;

-- -----------------------------------------------------------------------------
-- RUN THIS SEPARATELY, after confirming the material id (Алекс, виконай сам):
--
--   select id, title, name, format, page_count
--   from public.materials
--   where format = 'pdf' and name ilike '%matematyka%6%klas%ister%2023%1%';
--
-- then, with that id:
--
--   update public.course_v2_packages
--   set textbook_material_id = '<material id from the query above>'
--   where package_key = 'ister_2023_math6_part1_v2';
-- -----------------------------------------------------------------------------
