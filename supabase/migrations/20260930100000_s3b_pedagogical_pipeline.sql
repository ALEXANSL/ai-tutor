-- =============================================================================
-- S3 (strengthened, D-55) / Pedagogical lesson pipeline (ADR-022):
-- lesson_planning -> lesson_generation -> lesson_review (independent
-- provider) -> up to 2 revisions -> "methodical passport" + review history.
--
-- Requirements: US-6.9…6.14, NFR-COST-12; docs/02 7.3, 7.7; ADR-005, ADR-014,
-- ADR-022. Builds on 20260928100000_s3_lesson_orchestrator.sql.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / drop+add for the
-- one check constraint that needs new values / ON CONFLICT DO NOTHING).
-- Requires the S0-S3 migrations (in particular S3's `library_items`).
-- =============================================================================

-- `status` grows two values: a block is `draft` only for the instant between
-- insert and the pipeline's own update (defensive — the app inserts the
-- final status directly), `needs_review` for a block that never got an
-- `approved` review after MAX_REVISIONS (ADR-022 step 5) and is hidden from
-- the child by the existing `library_items_select` RLS policy (S3), which
-- already only lets a child see `status = 'active'`.
alter table public.library_items drop constraint if exists library_items_status_check;
alter table public.library_items
  add constraint library_items_status_check
  check (status in ('draft', 'active', 'needs_review', 'superseded'));

-- The "methodical passport" (US-6.10) and the child's own optional feedback
-- (US-6.13 КП-3 / US-6.10 КП-3, aggregated — never raw per-session rows, so
-- no child-identifying data lives on shared/reusable library content).
alter table public.library_items
  add column if not exists pedagogy jsonb not null default '{}'::jsonb,
  add column if not exists child_feedback jsonb not null default '{"interesting": 0, "normal": 0, "boring": 0}'::jsonb;
comment on column public.library_items.pedagogy is
  'Methodical passport (US-6.10): {goalUk, hookUk, visibleOutcomeUk, techniques: [{key, whyUk}], misconceptionsUk, comprehensionChecksUk, reviewStatus}.';
comment on column public.library_items.child_feedback is
  'Aggregated one-tap feedback (US-6.13 КП-3, M-13): {interesting, normal, boring} counts — never tied to a session or child identity.';

-- ---------------------------------------------------------------------------
-- Review history (ADR-022 §Дані, US-6.11 КП-3/КП-6): one row per
-- lesson_review call (first pass + each revision's re-review) — audit trail
-- and the "пройшов з першого разу / після доопрацювання / needs_review"
-- status shown in the library card (M-10).
-- ---------------------------------------------------------------------------
create table if not exists public.library_item_reviews (
  id                uuid primary key default gen_random_uuid(),
  owner_family_id   uuid references public.families (id) on delete cascade,
  library_item_id   uuid not null references public.library_items (id) on delete cascade,
  iteration         smallint not null check (iteration >= 1),
  reviewer_role     text not null default 'lesson_review',
  provider          text not null,
  model             text not null,
  verdict           text not null check (verdict in ('approved', 'revise', 'rejected')),
  scores            jsonb not null default '{}'::jsonb,
  notes             text,
  created_at        timestamptz not null default now(),
  unique (library_item_id, iteration)
);
create index if not exists library_item_reviews_owner_idx on public.library_item_reviews (owner_family_id);
create index if not exists library_item_reviews_item_idx on public.library_item_reviews (library_item_id, iteration);
comment on table public.library_item_reviews is
  'Independent-provider review history for a lesson block (ADR-022 step 3/4, US-6.11): audit trail + library card status (M-10).';

alter table public.library_item_reviews enable row level security;

-- Only the parent sees review notes/scores (methodical detail, US-6.10 КП-4:
-- the passport itself — of which this is the backing detail — is never
-- shown to the child, only the lesson's own text/steps are).
drop policy if exists library_item_reviews_select on public.library_item_reviews;
create policy library_item_reviews_select on public.library_item_reviews
  for select to authenticated
  using (
    owner_family_id = (select public.app_family_id())
    and (select public.app_role()) = 'parent'
  );

revoke all on public.library_item_reviews from anon;
revoke insert, update, delete, truncate on public.library_item_reviews from authenticated;

-- ---------------------------------------------------------------------------
-- Model routes for the new pipeline roles (ADR-005, ADR-022). `lesson_review`
-- **must** be a different provider than `lesson_generation`/`lesson_planning`
-- (Claude) — OpenAI here, per ADR-022's rationale (already the confirmed
-- reserve provider for lesson generation, docs/02 7.3). The exact OpenAI
-- model id ("gpt-5.6-sol", as used throughout docs/02 and ADR-022) should be
-- re-checked against the OpenAI console before the first real lesson demo,
-- same caveat as `indexing_structure`'s OpenAI fallback (docs/STATUS.md) —
-- the router works with any valid id configured here, this is just the seed.
-- No `economy_provider` is set for `lesson_review`: NFR-COST-12 / US-6.11
-- КП-4 keep the review itself off the economy path entirely (enforced in
-- code via `BUDGET_EXEMPT_ROLES`, not by omitting a route — this is belt and
-- suspenders documentation of the same rule).
-- ---------------------------------------------------------------------------
create or replace function app_private.seed_s3b_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, escalation_provider, escalation_model, params)
  values
    (p_family, 'lesson_planning', 'anthropic', 'claude-opus-5-5', null, null,
     '{"max_tokens": 8000, "effort": "medium", "timeout_ms": 90000}'::jsonb),
    (p_family, 'lesson_review', 'openai', 'gpt-5.6-sol', null, null,
     '{"max_tokens": 4000, "effort": "medium", "timeout_ms": 90000}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_s3b_model_routes(uuid) from public;

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
  return new;
end;
$$;
-- Trigger already exists from S1 (same name); only the function body changed
-- and `create or replace` above already applied it.

-- Existing families (S0-S3 already deployed).
select app_private.seed_s3b_model_routes(f.id) from public.families f;
