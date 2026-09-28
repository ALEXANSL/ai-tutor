-- =============================================================================
-- Cost-safety fix, real prod concern (2026-09-28 incident): a book showed a
-- per-section `indexing_structure` spend far above the expected range.
--
-- Root cause (confirmed architecturally, `app/src/server/ingest/pipeline.ts`):
-- `runStructureSection` (ADR-032 pass 2) and `runStructureOutline` (pass 1)
-- each make ONE paid, non-idempotent AI call and then do several more
-- deterministic DB writes. Those writes throw a plain `Error` on failure,
-- which `isRetryableIngestError` treats as retryable — so a transient DB/RPC
-- hiccup AFTER a successful, already-billed AI call re-ran the WHOLE job,
-- including a SECOND paid call for the same section/book. Up to
-- `max_attempts` (5) paid calls could be billed for one successful outcome.
--
-- Fix: a checkpoint column on each row. The AI call's raw answer is saved
-- here immediately after a successful call, BEFORE any downstream write
-- starts. A retry that re-enters the function finds the cached answer and
-- skips straight to the (idempotent, free) DB writes instead of paying for
-- the model again. Both columns are cleared once their row reaches a
-- terminal, successful state, so a later GENUINE re-index (not a retry)
-- never reuses a stale cached answer.
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

alter table public.material_sections
  add column if not exists structure_result jsonb;

comment on column public.material_sections.structure_result is
  'ADR-032 cost-safety checkpoint: the raw indexing_structure AI answer for '
  'this section, cached right after a successful (billed) call and BEFORE '
  'the downstream topic/exercise DB writes below it run. A retry of '
  'ingest.structure_section (triggered by one of those downstream writes '
  'failing) reuses this instead of paying for the model again. Cleared once '
  'the section reaches status=ready, and whenever ingest.structure_outline '
  're-queues this section for a genuine re-index (so a stale answer is '
  'never reused across a real re-index, only across retries of the same '
  'run).';

alter table public.materials
  add column if not exists structure_outline_result jsonb;

comment on column public.materials.structure_outline_result is
  'Same ADR-032 cost-safety checkpoint as material_sections.structure_result, '
  'for the indexing_outline call in ingest.structure_outline (pass 1). '
  'Cleared once the outline pass finishes fanning out its '
  'ingest.structure_section jobs.';
