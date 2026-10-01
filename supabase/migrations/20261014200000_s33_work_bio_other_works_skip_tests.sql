-- =============================================================================
-- S33 follow-up / PO feedback 2026-10-01 (first real lesson, Гоголь "Ніч
-- перед Різдвом"): two unrelated fixes bundled in one migration.
--
-- 1. `literature_lessons.work_author_bio_uk` / `work_other_works_uk` —
--    the textbook itself carries a real author biography and mentions of
--    the author's other works; the extraction prompt crammed everything
--    into one short `explanation_md`, so both got lost. New optional
--    columns, matching the new optional `work.authorBioUk`/`otherWorksUk`
--    fields in `literatureTopicSchema`
--    (app/src/server/lessons/literature-schema.ts) — never invented,
--    same "nothing invented" rule as every other `work_*` column.
--
-- 2. `parent_settings.allow_skip_tests` — PO: "у нас 3-4 слайди з коротким
--    текстом та тестами які не можна пропустити! зроби кнопку яку можна
--    показувати/ховати з налаштувань". A GENERAL app setting (not
--    literature-specific), one row per family, same pattern as
--    `parent_mode_idle_min` (see 20260925100200_s0_parent_child_persona.sql).
--    Defaults to `false` (off) so no existing family's behaviour changes
--    until the parent explicitly turns it on.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS everywhere).
-- Requires S0 and S33 migrations.
-- =============================================================================

alter table public.literature_lessons
  add column if not exists work_author_bio_uk text,
  add column if not exists work_other_works_uk text;

comment on column public.literature_lessons.work_author_bio_uk is
  'PO feedback 2026-10-01: a real, substantive biography paragraph of the work''s author, when the source text itself covers one — never invented. Null when the source text has no author biography, or the topic has no literary work.';
comment on column public.literature_lessons.work_other_works_uk is
  'PO feedback 2026-10-01: mentions of the author''s other well-known works, ONLY if the source text itself mentions them — never invented, never a general-knowledge list. Null when the source text does not mention any.';

alter table public.parent_settings
  add column if not exists allow_skip_tests boolean not null default false;

comment on column public.parent_settings.allow_skip_tests is
  'PO feedback 2026-10-01: when true, the child sees a "Пропустити" (skip) button on test/quiz questions instead of being blocked until answered. Defaults to off.';

-- Column-level grant mirrors 20260925100200_s0_parent_child_persona.sql's
-- grant exactly, plus the new column (pin_hash stays excluded).
revoke select on public.parent_settings from authenticated;
grant select (
  family_id, pin_updated_at, pin_failed, pin_locked_until, pin_max_attempts,
  pin_lock_minutes, parent_mode_idle_min, tutor_name_options, persona_child_editable,
  allow_skip_tests, created_at, updated_at
) on public.parent_settings to authenticated;
