-- =============================================================================
-- S1b / Scanned books (OCR) — PO decision D-54 (docs/01 12.9).
--
-- A PDF page without a text layer is recognised by a vision-capable model
-- through the router (new role `ocr_page`), once per page, results stored as
-- page text and merged into the ordinary text pipeline (chunks → embeddings →
-- structure). A book over the parent's page threshold waits for the parent's
-- "Розпізнати" before spending anything (D-54); a small book OCRs on its own.
--
-- Requirements: US-2.2 (статус «Розпізнається…»), US-2.6; ADR-008 (note),
-- ADR-012 (budget mode defers OCR, same as `indexing_structure`).
--
-- Safe to re-run in the Supabase SQL Editor.
-- Requires 20260926100000_s1_ai_router_costs_jobs.sql and
-- 20260926100100_s1_materials_search.sql.
-- =============================================================================

-- Parent-configurable threshold: books at or below this page count OCR
-- automatically; larger books show a cost estimate and wait for "Розпізнати".
alter table public.parent_settings
  add column if not exists ocr_confirm_above_pages integer not null default 20
    check (ocr_confirm_above_pages > 0);

-- Materials: OCR bookkeeping + a new status while a large scan waits for the
-- parent's confirmation (docs/02 8.2, US-2.2 KP-3).
alter table public.materials
  add column if not exists ocr_pages_total integer,
  add column if not exists ocr_pages_done integer not null default 0,
  add column if not exists ocr_estimated_cost_usd numeric(10, 4),
  add column if not exists ocr_confirmed_at timestamptz,
  add column if not exists ocr_confirmed_by uuid references public.app_users (id) on delete set null;

alter table public.materials drop constraint if exists materials_status_check;
alter table public.materials add constraint materials_status_check
  check (status in ('queued', 'indexing', 'ready', 'error', 'scan_no_text', 'scan_awaiting_ocr',
                     'deferred', 'removed'));
comment on column public.materials.status is
  'scan_awaiting_ocr: a large scan is waiting for the parent''s "Розпізнати" (D-54, ocr_confirm_above_pages). '
  'scan_no_text now also covers "розпізнати не вдалося" (status_detail = scan_unreadable) alongside the S1 '
  'meaning (no scan pages found at all, status_detail = scan_no_text).';

-- Per-page OCR results (resumable: `ingest.ocr` processes a few pages per tick
-- and can be interrupted/restarted freely; re-indexing the same file — same
-- content_hash — never re-runs OCR because ingest.extract already skips
-- straight to embedding when the hash and chunk count are unchanged).
create table if not exists public.material_ocr_pages (
  id               uuid primary key default gen_random_uuid(),
  owner_family_id  uuid references public.families (id) on delete cascade,
  material_id      uuid not null references public.materials (id) on delete cascade,
  page             integer not null check (page > 0),
  status           text not null default 'pending' check (status in ('pending', 'done', 'unreadable')),
  text             text not null default '',
  ai_call_id       uuid references public.ai_calls (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (material_id, page)
);
create index if not exists material_ocr_pages_owner_idx on public.material_ocr_pages (owner_family_id);
create index if not exists material_ocr_pages_pending_idx
  on public.material_ocr_pages (material_id) where status = 'pending';
drop trigger if exists material_ocr_pages_touch on public.material_ocr_pages;
create trigger material_ocr_pages_touch before update on public.material_ocr_pages
  for each row execute function app_private.touch_updated_at();

-- Model route for the new role (ADR-005 note below). Fallback is left unset
-- for the same reason as `indexing_structure` (docs/STATUS.md): the exact
-- GPT-5.6 Sol id is not yet confirmed in the OpenAI console, and today only
-- the Anthropic adapter implements the `vision` provider kind (router.ts).
-- Budget mode defers OCR entirely (US-11.5 KP-6, D-54 "режим бюджету —
-- відкладати OCR"), same policy as `indexing_structure`.
create or replace function app_private.seed_s1b_model_routes(p_family uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.model_routes (family_id, role, primary_provider, primary_model, params)
  values
    (p_family, 'ocr_page', 'anthropic', 'claude-sonnet-5',
     '{"max_tokens": 8000, "effort": "low", "timeout_ms": 120000, "budget_policy": "defer"}'::jsonb)
  on conflict (family_id, role) do nothing;
$$;
revoke all on function app_private.seed_s1b_model_routes(uuid) from public;

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
  return new;
end;
$$;
-- Trigger already exists (same name, S1); only the function body changed.

-- Existing families.
select app_private.seed_s1b_model_routes(f.id) from public.families f;

-- RLS: parent-only read (server writes with service role), matching every
-- other table added for the "Мої книги" pipeline in S1.
alter table public.material_ocr_pages enable row level security;
drop policy if exists material_ocr_pages_select_parent on public.material_ocr_pages;
create policy material_ocr_pages_select_parent on public.material_ocr_pages
  for select to authenticated
  using (owner_family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');
revoke all on public.material_ocr_pages from anon;
revoke insert, update, delete, truncate on public.material_ocr_pages from authenticated;
