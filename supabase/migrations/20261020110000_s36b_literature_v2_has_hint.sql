-- S36 follow-up: `literature_v2_task_keys` has NO select grant for any
-- client role (see 20261020100000's migration header) — the child-facing
-- view (`literatureV2View.ts`) therefore cannot determine "does this task
-- have hints/a model answer" by querying that table live, the same way
-- `course_v2_exercises.has_source_issue` (S35) is computed once at IMPORT
-- time (service-role) rather than read live from a similarly-locked table.
-- Safe to re-run (IF NOT EXISTS).
alter table public.literature_v2_tasks
  add column if not exists has_hint boolean not null default false;
