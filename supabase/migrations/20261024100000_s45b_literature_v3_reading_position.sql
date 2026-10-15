-- =============================================================================
-- S45, 2nd pass, part 4/4 — reading position for `literature_v3` lessons
-- (US-31.2 КП-2).
--
-- DEVIATION FROM docs/02-architecture.md §18.1 / ADR-044 §1, FLAGGED FOR
-- ARCHITECT REVIEW (see this slice's handback report): those documents
-- specified a new nullable `lesson_sessions.reading_position` column
-- (already added by the first pass's migration,
-- `20261023100000_s45_literature_v3.sql`). On inspection, `lesson_sessions`
-- is the FULL S3 lesson-orchestrator table (`mode`, `planned_minutes`,
-- `current_step_id` referencing `library_steps`, budget/active-seconds
-- tracking consumed by the parent dashboard and budget system elsewhere) —
-- `literature_v3` (like `math_course_v2`/`literature_v2` before it) creates
-- NO `lesson_sessions` row at all; its viewer is a standalone
-- flow[]-rendering screen, not an orchestrator-driven session. Writing a
-- real `lesson_sessions` row just to carry one jsonb field would either (a)
-- need every other NOT NULL orchestrator column faked with meaningless
-- defaults, risking contaminating features that scan "this child's active
-- session" (budget tracking, parent "зараз на уроці" status), or (b) need a
-- genuine orchestrator integration, far outside this story's scope.
--
-- This migration instead adds a SMALL, DEDICATED table scoped by
-- (child_profile_id, lesson_id) — same idea, same shape of value
-- ({kind, ref_id, offset_codepoints}), zero risk to the orchestrator. The
-- `lesson_sessions.reading_position` column from the first pass's migration
-- is left in place, unused — a future ADR update can either wire it up for
-- real (if `literature_v3` ever DOES grow a real session) or drop it;
-- not decided here.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS everywhere).
-- Requires S0 (`child_profile`), S45's own `literature_v3_lessons`.
-- =============================================================================

create table if not exists public.literature_v3_reading_positions (
  owner_family_id   uuid references public.families (id) on delete cascade,
  child_profile_id  uuid not null references public.child_profile (id) on delete cascade,
  lesson_id         uuid not null references public.literature_v3_lessons (id) on delete cascade,
  -- {kind:"reading", ref_id, offset_codepoints} — offset is in Unicode CODE
  -- POINTS of the reading item's `content_tts.text` (same explicit
  -- INTEGRATION.md requirement the first pass's migration comment already
  -- documents), derived here from the reader's own scroll position (US-31.2
  -- КП-2's "повернення до місця" — no live audio seek in this slice, see
  -- handback report).
  position          jsonb not null,
  updated_at        timestamptz not null default now(),
  primary key (child_profile_id, lesson_id)
);
create index if not exists literature_v3_reading_positions_owner_idx on public.literature_v3_reading_positions (owner_family_id);

alter table public.literature_v3_reading_positions enable row level security;

-- Same shape as every other literature_v3_* policy: parent full read, no
-- client-side writes at all (the save/clear/read server actions all use the
-- service-role client, same as every other write in this family of tables).
drop policy if exists literature_v3_reading_positions_select_parent on public.literature_v3_reading_positions;
create policy literature_v3_reading_positions_select_parent on public.literature_v3_reading_positions
  for select to authenticated
  using (owner_family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

revoke all on public.literature_v3_reading_positions from anon;
revoke insert, update, delete, truncate on public.literature_v3_reading_positions from authenticated;
