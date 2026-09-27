-- =============================================================================
-- S5 / US-6.16 (D-80/D-81, D-89): lesson-screen navigation + presentation
-- mode ("голос/текст"), and the new `passive_narration` role (ADR-025) that
-- reads already-generated step text aloud with OpenAI `gpt-4o-mini-tts`
-- (Gemini `gemini-3.8-flash-tts` recorded as the ADR's alternative/fallback
-- provider — same documented caveat as `lesson_review`'s OpenAI model id
-- elsewhere in these migrations: no Gemini adapter is implemented yet in
-- `src/server/ai/providers`, so this route's fallback is inert until one is
-- added; the primary (OpenAI) path is fully wired).
--
-- Requirements: US-6.16 КП-5/КП-6 (docs/01, §"US-6.16"), ADR-025, D-89.
-- Follows the BUG-023 pattern for adding a new checked value (drop + add the
-- constraint) and the S3b/S4 pattern for seeding a new `model_routes` role.
--
-- Safe to re-run in the Supabase SQL Editor.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- `lesson_sessions.presentation_mode` (US-6.16 КП-5): 'voice' forces
-- continuous narration ("аудіокнига"), 'text' turns narration off, 'auto'
-- (default) is today's unchanged behaviour. Child-owned session state, so it
-- lives here rather than in `parent_settings` (КП-6's per-subject *default*
-- is a separate, later concern for the subject registry, NFR-PLAT-6 — this
-- column only holds the session's current, possibly child-changed, choice).
-- ---------------------------------------------------------------------------
alter table public.lesson_sessions
  add column if not exists presentation_mode text not null default 'auto';

alter table public.lesson_sessions drop constraint if exists lesson_sessions_presentation_mode_check;
alter table public.lesson_sessions
  add constraint lesson_sessions_presentation_mode_check
  check (presentation_mode in ('voice', 'auto', 'text'));

comment on column public.lesson_sessions.presentation_mode is
  'US-6.16 КП-5: voice/auto/text switch in the lesson-screen header (docs/04 §5.2). Never affects points or grading.';

-- ---------------------------------------------------------------------------
-- Price row for the new TTS role (docs/03 2.2.2, ADR-025 §Дослідження). The
-- `/v1/audio/speech` endpoint has no per-call token usage in its response, so
-- the router's existing per-token cost formula (policy.ts `estimateCostUsd`)
-- is reused by treating the input TEXT LENGTH (characters) as `inputTokens`
-- and leaving `outputTokens` at 0 — `input_usd_per_mtok` below is therefore
-- priced per **million characters**, not per million tokens, which is an
-- approximation of ADR-025's "$0.60/1M вхід (текст) + $12/1M вихід
-- (аудіотокени)" collapsed into one number (≈$0.03/1000 chars, mid-range of
-- the ADR's own $0.02–0.04/1000 estimate) until real usage is observed.
-- ---------------------------------------------------------------------------
insert into public.model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok, notes)
values
  ('openai', 'gpt-4o-mini-tts', 30, 0, 'ADR-025: approximated per input CHARACTER (not token) — see migration comment')
on conflict (provider, model) do nothing;

create or replace function app_private.seed_s5_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, fallback_provider, fallback_model, params)
  values
    (p_family, 'passive_narration', 'openai', 'gpt-4o-mini-tts', 'gemini', 'gemini-3.8-flash-tts',
     -- budget_policy "defer": in budget mode, narration is silently skipped
     -- (the child sees only text) rather than ever downgraded to a cheaper
     -- model or exempted from the budget — same "quietly falls back to text"
     -- rule already used for live voice availability (docs/04 §5).
     '{"timeout_ms": 30000, "budget_policy": "defer"}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_s5_model_routes(uuid) from public;

create or replace function app_private.families_seed_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.seed_default_model_routes(new.id);
  perform app_private.seed_s3_model_routes(new.id);
  perform app_private.seed_s1b_model_routes(new.id);
  perform app_private.seed_s3b_model_routes(new.id);
  perform app_private.seed_s4_model_routes(new.id);
  perform app_private.seed_s5_model_routes(new.id);
  return new;
end;
$$;
-- Trigger already exists (same name, S1); no need to recreate it.

-- Existing families get the new role too.
select app_private.seed_s5_model_routes(f.id) from public.families f;
