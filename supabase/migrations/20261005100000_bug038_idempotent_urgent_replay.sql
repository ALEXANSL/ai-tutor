-- BUG-038 (critical, safety): an idempotent replay of a submission (the
-- offline queue re-sending the same `idempotency_key` after a dropped
-- connection) skipped moderation on purpose (never double-call/double-charge
-- the AI), but that also meant BUG-013's safety override — the deterministic
-- `URGENT_REPLY_UK` go-to-dad reply for a `severity: "urgent"` answer — was
-- silently lost on replay: `verdict` was correctly re-read from the DB, but
-- the override fact itself was never stored anywhere, so the replay path
-- always produced an empty `explanation` instead of re-showing the safety
-- phrase.
--
-- Fix: persist the "this attempt's explanation IS the BUG-013 safety
-- override" fact on the row at first (non-idempotent) processing time, so a
-- replay can just read it back and reproduce the exact same response,
-- without ever re-running moderation.
alter table public.step_attempts
  add column if not exists moderation_forced_urgent boolean not null default false;
comment on column public.step_attempts.moderation_forced_urgent is
  'BUG-038: true when this attempt''s `verdict`/`explanation` were the BUG-013 deterministic safety override (moderation classified the child''s answer `severity: "urgent"`) rather than the model''s own evaluation. Read back on an idempotent replay (same idempotency_key) to reproduce URGENT_REPLY_UK without re-running moderation.';
