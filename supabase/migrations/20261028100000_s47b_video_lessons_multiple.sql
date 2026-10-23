-- =============================================================================
-- S47 follow-up (Алекс 2026-10-23): "додай можливість завантажувати по
-- декілька відео файлів до кожної теми" — a topic can now have more than
-- one Pictory video attached (e.g. a main explainer + a recap). Drops the
-- `unique (topic_id)` constraint from the original S47 migration
-- (20261027100000) — every upload now INSERTS a new row instead of
-- replacing the topic's one existing video.
--
-- Safe to re-run in the Supabase SQL Editor (IF EXISTS everywhere).
-- =============================================================================

alter table public.video_lessons drop constraint if exists video_lessons_topic_id_key;

-- The old unique constraint also backed lookups by topic — replace it with
-- a plain (non-unique) index so `eq("topic_id", ...)` queries stay fast.
create index if not exists video_lessons_topic_idx on public.video_lessons (topic_id);
