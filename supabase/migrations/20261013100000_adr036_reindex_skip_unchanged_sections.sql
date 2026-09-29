-- =============================================================================
-- ADR-036 recommendation #1: skip re-structuring sections whose source text
-- has not changed since their last successful `ingest.structure_section` run.
--
-- Today, re-indexing a book (parent clicks "Переіндексувати") re-runs the
-- paid `indexing_structure` AI call for EVERY section unconditionally
-- (`runStructureOutline`'s "update"/"keep" branches always reset
-- `material_sections.status` to 'pending' and clear `structure_result`), even
-- when a section's own text is byte-for-byte identical to what was
-- successfully structured last time. A re-index therefore costs exactly as
-- much as the first index, with zero savings for unchanged content.
--
-- Adds one small column: `material_sections.source_text_hash` — a sha256 hex
-- digest of the section's own page-range text (`buildSectionText`/
-- `hashSectionText`), written once a section's own `ingest.structure_section`
-- run reaches `status = 'ready'`. On a later re-index, `runStructureOutline`
-- recomputes this hash for the section's (possibly updated) page range and
-- skips re-queueing `ingest.structure_section` for it when the section is
-- already `status = 'ready'` AND the hash is unchanged — reusing the
-- existing topics/material_problems/chunks structure data as-is. A section
-- whose text actually changed (different hash) is still re-structured
-- exactly as before; the very first index of a book has no prior hash to
-- compare against, so every section is structured as normal (unaffected).
--
-- Safe to re-run in the Supabase SQL Editor.
-- Requires 20261009100000_adr032_incremental_structure.sql.
-- =============================================================================

alter table public.material_sections
  add column if not exists source_text_hash text;

comment on column public.material_sections.source_text_hash is
  'ADR-036 #1: sha256 hex digest of this section''s own page-range text (buildSectionText), written when the section reaches status=ready. Used on the NEXT re-index to skip re-running the paid indexing_structure call when the section''s text has not changed (see runStructureOutline in app/src/server/ingest/pipeline.ts).';
