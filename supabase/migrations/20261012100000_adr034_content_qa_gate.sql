-- =============================================================================
-- ADR-034 / content_qa: deterministic ($0 AI) technical QA gate run BEFORE
-- the paid `lesson_review` role — completeness, encoding sanity, and
-- verbatim-quote-vs-source fidelity. Two real content bugs (BUG-011
-- mid-sentence truncation, BUG-046 CP1251 mojibake) shipped undetected
-- because `lesson_review` is a *pedagogical* rubric, not a technical linter.
--
-- Requirements: ADR-034 (docs/adr/034-content-fidelity-qa-gate.md), US-6.11,
-- US-6.9 КП-3/5/6, NFR-LANG-3, NFR-LANG-6 (D-114), ADR-029 §1 (same
-- deterministic-check precedent, `verifyProblemNumbers`). Builds on
-- 20260930100000_s3b_pedagogical_pipeline.sql (library_item_reviews) and
-- 20260930110000_bug011_fallback_status.sql (`status = 'fallback'`).
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / drop+add for the
-- one check constraint that needs a new value).
-- =============================================================================

-- WHY a block ended up `needs_review`: a failed `content_qa` gate
-- ("technical", ADR-034) vs. an unapproved `lesson_review` ("pedagogical",
-- unchanged behaviour). NULL for any other status. Lets the parent
-- notification/log say what actually went wrong instead of one generic
-- "needs review" state (ADR-034 § "Що відбувається при провалі").
alter table public.library_items
  add column if not exists needs_review_reason text;
alter table public.library_items drop constraint if exists library_items_needs_review_reason_check;
alter table public.library_items
  add constraint library_items_needs_review_reason_check
  check (needs_review_reason is null or needs_review_reason in ('pedagogical', 'technical'));
comment on column public.library_items.needs_review_reason is
  'ADR-034: why status=needs_review — ''technical'' (content_qa gate failed: truncation/encoding) or ''pedagogical'' (lesson_review never approved). NULL otherwise.';

-- The `content_qa` gate's own result for this item's currently-saved
-- content — written both by the live generation/fallback pipeline
-- (`content-qa.ts`, `pipeline.ts`, `generate.ts`) and by the one-time
-- retroactive sweep script (ADR-034 § "Ретроактивний sweep") so both paths
-- share one field and one shape:
--   { status: 'checked_ok' | 'flagged', failures: [{stepIndex, field, code, reason}], checkedAt }
-- NULL means "never checked" (rows saved before this migration).
alter table public.library_items
  add column if not exists content_qa jsonb;
comment on column public.library_items.content_qa is
  'ADR-034: last content_qa check result — {status: checked_ok|flagged, failures: [...], checkedAt}. NULL = not yet checked (pre-ADR-034 row, or sweep has not reached it).';

-- `library_item_reviews.reviewer_role` already accepts free text (S3B
-- migration: `reviewer_role text not null default 'lesson_review'`, no check
-- constraint) — content_qa's synthetic verdict rows
-- (reviewer_role='content_qa', provider='deterministic',
-- model='rule-based-v1') insert into the existing table with no schema
-- change, giving one unified audit trail (ADR-034 § "Дані").

-- Note (ADR-034 § "Дані"): `library_steps.source_refs[].verbatim boolean`
-- is a new key inside the existing `source_refs` jsonb array, not a new
-- column — no migration needed for it; `generate.ts`'s `getOrCreateFallbackBlock`
-- is the only writer that sets it today.

-- Index for the retroactive sweep's targeting query (ADR-034 § "Ретроактивний
-- sweep" step 1a: `status = 'fallback'` first, highest priority) — the
-- existing `library_items_topic_idx (topic_id, kind, status)` does not cover
-- a sweep that scans across all topics by status alone.
create index if not exists library_items_status_idx on public.library_items (status);
