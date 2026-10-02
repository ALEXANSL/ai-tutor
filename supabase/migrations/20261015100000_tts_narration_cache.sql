-- =============================================================================
-- TTS narration caching (PO complaint 2026-10-02: "перемикаюсь на голос...
-- кожен під модуль займає до 30 секунд поки ШІ починає читати вголос").
--
-- Root cause confirmed by reading `narration.ts`/`lesson.ts`/`openai.ts`:
-- `synthesizeStepNarration` calls the OpenAI TTS endpoint synchronously,
-- on-demand, only when the child is actually viewing a step in "voice"/
-- "auto" mode (`NarrationPlayer`'s mount effect) — there was NO caching at
-- all, so every single view of a step (including a revisit of the SAME step,
-- or a replay in a later session) paid a full `gpt-4o-mini-tts` round trip
-- again, and no prefetch happened for the next step while the child was
-- still on the current one. This migration adds the storage half of the
-- fix: the audio for a step's narration is now persisted on the step row
-- itself (`library_steps` rows ARE the reusable "library" content — US-6
-- "бібліотека уроків" already reuses them across sessions without
-- regenerating the lesson, so caching the narration on the same row is the
-- natural fit, not a new storage mechanism).
--
-- `narration_text_hash` guards against a stale cache: if a step's own text
-- ever changes (edit/regeneration), the hash no longer matches and the next
-- play resynthesizes once, same safety property as everywhere else in this
-- schema that memoizes a derived artifact next to its source.
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

alter table public.library_steps
  add column if not exists narration_text_hash text,
  add column if not exists narration_audio_base64 text,
  add column if not exists narration_audio_mime text,
  add column if not exists narration_cached_at timestamptz;

comment on column public.library_steps.narration_text_hash is
  'SHA-256 (hex) of the exact text last sent to passive_narration TTS for this step, so a later edit to the step content invalidates the cached audio below.';
comment on column public.library_steps.narration_audio_base64 is
  'Cached TTS output (base64 mp3) for narration_text_hash, so revisiting/replaying the same step never re-synthesizes (PO complaint 2026-10-02, ~30s per step with no caching before this).';
comment on column public.library_steps.narration_audio_mime is
  'MIME type of narration_audio_base64 (currently always audio/mpeg from gpt-4o-mini-tts).';
comment on column public.library_steps.narration_cached_at is
  'When narration_audio_base64 was written, for observability only (no TTL eviction — mirrors this table''s existing no-expiry content).';
