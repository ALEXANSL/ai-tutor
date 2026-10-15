-- =============================================================================
-- S45 hotfix (D-128, 2026-10-15): real import failure Alex hit on the first
-- try — "course_v2_quizzes upsert failed for ukrlit6-...-L001: there is no
-- unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Root cause: `20261023100000_s45_literature_v3.sql` added PARTIAL unique
-- indexes (`where literature_v3_lesson_id is not null`) on
-- `course_v2_quizzes`/`course_v2_questions`. Postgres only lets a plain
-- `ON CONFLICT (col1, col2)` target a partial index if the INSERT's own
-- `ON CONFLICT` clause repeats that index's WHERE predicate — which
-- `literatureV3Persist.ts`'s `onConflict: "literature_v3_lesson_id,quiz_key"`
-- (via supabase-js) does not do, so Postgres can't find a matching arbiter
-- and rejects the upsert outright.
--
-- Fix: drop the partial indexes, replace with plain (non-partial) unique
-- indexes on the same two columns — exactly how the ORIGINAL math-only
-- `unique (lesson_id, question_key)` / `unique (lesson_id, quiz_key)`
-- constraints already work (`20261017100000_s35_math_course_v2.sql`).
-- Safe: ordinary SQL NULL semantics mean multiple rows with
-- `literature_v3_lesson_id is null` (every pre-existing math row) never
-- collide with each other under a plain unique index — nothing about the
-- existing math rows changes.
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

drop index if exists public.course_v2_quizzes_lit_v3_lesson_key_idx;
create unique index if not exists course_v2_quizzes_lit_v3_lesson_key_idx
  on public.course_v2_quizzes (literature_v3_lesson_id, quiz_key);

drop index if exists public.course_v2_questions_lit_v3_lesson_key_idx;
create unique index if not exists course_v2_questions_lit_v3_lesson_key_idx
  on public.course_v2_questions (literature_v3_lesson_id, question_key);
