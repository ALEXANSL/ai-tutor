-- =============================================================================
-- BUG-011 fix: `library_items.status` grows one value, `fallback`, for the
-- "safe simplified template" (US-6.11, ADR-022 step 5) used when a topic's
-- generation never produced a single reviewer-approved block (reviewer
-- unavailable, e.g. no OPENAI_API_KEY, or every attempt ended
-- `needs_review`) — a deterministic, non-AI block (verbatim textbook excerpt
-- + one grounded yes/no check) so a lesson can still start.
--
-- A `fallback` block is never selected by the normal "active" candidate
-- query (`getOrGenerateLessonBlocks`/`nextSessionBlock`'s `loadCandidates`,
-- which filters `status = 'active'`), so it is only ever used through the
-- explicit `getOrCreateFallbackBlock` path — this migration only widens the
-- check constraint and RLS so the child's own session (already scoped by
-- `session_blocks`/service-role reads, not by `library_items_select`
-- directly) can still show it, and the parent's library cabinet can query it
-- like any other status.
--
-- Requirements: US-6.11, docs/bugs/BUG-011-no-safe-template-fallback-when-
-- review-fails.md. Builds on 20260930100000_s3b_pedagogical_pipeline.sql.
--
-- Safe to re-run in the Supabase SQL Editor (drop+add the one constraint
-- that needs the new value; the RLS policy uses `create or replace` via
-- drop-if-exists + create, as every other migration in this project does).
-- =============================================================================

alter table public.library_items drop constraint if exists library_items_status_check;
alter table public.library_items
  add constraint library_items_status_check
  check (status in ('draft', 'active', 'needs_review', 'superseded', 'fallback'));

-- A `fallback` block is deterministic and pre-approved by construction (no
-- free AI generation, US-6.11) — the child may see it exactly like an
-- `active` one; only `needs_review` stays hidden from her.
drop policy if exists library_items_select on public.library_items;
create policy library_items_select on public.library_items
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (
      (select public.app_role()) = 'parent'
      or ((select public.app_role()) = 'child' and status in ('active', 'fallback'))
    )
  );

drop policy if exists library_steps_select on public.library_steps;
create policy library_steps_select on public.library_steps
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and exists (
      select 1 from public.library_items li
       where li.id = library_steps.item_id
         and ((select public.app_role()) = 'parent' or li.status in ('active', 'fallback'))
    )
  );
