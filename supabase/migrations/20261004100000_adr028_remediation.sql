-- ADR-028 (D-104, US-6.15/US-8.7): remediation dialog — "stop the step,
-- explain the specific mistake, reinforce, resume exactly where it stopped".
--
-- US-6.15 lives entirely inside the already-existing lesson state machine
-- (`lesson_sessions`/`step_attempts`, ADR-007): `current_step_id` never
-- changes during remediation — "are we mid-remediation" is a derived
-- predicate over `step_attempts`, not a new session-level field (see
-- `app/src/server/lessons/state-machine.ts` `isRemediationRetryAttempt`,
-- the same consecutive-failure count `decideBranch` already computes). The
-- ONLY schema change this needs is one nullable, purely-cache column:
alter table public.step_attempts
  add column if not exists remediation jsonb null;
comment on column public.step_attempts.remediation is
  'ADR-028: filled only on the attempt that STARTED the "explain -> reinforce" cycle (attempt_no=1, verdict != correct, step has remediation content): { explanationUk, retryVariantIndex, source: "cached"|"live", retryProps? } — caches a live call''s result (open steps) for an idempotent re-show on reload/resume and for the journal (US-6.15 КП-7), without ever calling the model twice for the same attempt.';

-- US-8.7 ("поясни задачу №N") lives in the per-topic chat instead
-- (`chats`/`messages`, no lesson step/attempt at all) — state is derived the
-- same way, from the chat's own message history via one generalized tagging
-- column (this migration only adds the column; the chat-side mechanism
-- itself is deferred, see docs/adr/028-remediation-dialog-stop-explain-resume.md §3).
alter table public.messages
  add column if not exists meta jsonb not null default '{}'::jsonb;
comment on column public.messages.meta is
  'ADR-028: generalized tagging for sequential AI sub-flows inside one chat (today, only US-8.7 "поясни задачу №N": { kind: "homework_problem", problemNumber, stage: "method"|"attempt_feedback"|"fallback"|"solved", attemptNo }). Empty object for every other message (ordinary US-8.1/8.2 Q&A) — no data migration needed.';
