-- =============================================================================
-- Book upload from the browser + shared Google Drive `drive.file` connector
-- (ADR-024, D-79). One OAuth consent from the parent stores a refresh token
-- (encrypted, same pgcrypto pattern as the Telegram chat id — S4 migration)
-- and lets the app create + auto-share its own "ШІ-Репетитор — Мої книги"
-- folder with the existing materials-reading service account, so uploaded
-- books join the S1/S1b indexing pipeline without a manual Drive "Share"
-- step. Kept general enough to be reused by the future media archive
-- (D-67/S17) without a schema change (docs/02 10.3, ADR-024 "Наслідки").
--
-- Requirements: US-2.6 КП-5, US-2.7 КП-1/3/4/5, NFR-PRIV-7, NFR-PRIV-10.
--
-- Safe to re-run in the Supabase SQL Editor.
-- Requires 20261001100000_s4_safety_notifications.sql (pgcrypto extension).
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- One row per family: the parent's `drive.file` OAuth grant. The refresh
-- token is the only sensitive value here and is stored encrypted with a key
-- derived from GOOGLE_OAUTH_CLIENT_SECRET (a secret only the server holds for
-- this very OAuth client) — never selectable in plain text by any client.
create table if not exists public.drive_oauth_connections (
  family_id           uuid primary key references public.families (id) on delete cascade,
  refresh_token_enc   bytea,
  -- Drive id of the app-created, app-owned "ШІ-Репетитор — Мої книги" folder,
  -- shared read-only with the materials service account (ADR-024 §2-3). The
  -- parent still copies this id into GOOGLE_DRIVE_UPLOADS_FOLDER_ID once (the
  -- same one-time step already used for the archive folder, docs/03 1.6.6).
  uploads_folder_id   text,
  connected_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
drop trigger if exists drive_oauth_connections_touch on public.drive_oauth_connections;
create trigger drive_oauth_connections_touch before update on public.drive_oauth_connections
  for each row execute function app_private.touch_updated_at();

alter table public.drive_oauth_connections enable row level security;

drop policy if exists drive_oauth_connections_select_parent on public.drive_oauth_connections;
create policy drive_oauth_connections_select_parent on public.drive_oauth_connections
  for select to authenticated
  using (family_id = (select public.app_family_id()) and (select public.app_role()) = 'parent');

revoke all on public.drive_oauth_connections from anon;
revoke insert, update, delete, truncate on public.drive_oauth_connections from authenticated;
-- Column-level grant, same style as `parent_settings.pin_hash`: the encrypted
-- refresh token is never selectable by any client, even as ciphertext.
revoke select on public.drive_oauth_connections from authenticated;
grant select (family_id, uploads_folder_id, connected_at, created_at, updated_at)
  on public.drive_oauth_connections to authenticated;

-- SECURITY DEFINER RPCs: only the server (service_role) calls these, with the
-- OAuth client secret passed in as the passphrase (never stored) — same
-- style as `set_telegram_chat_id`/`get_telegram_chat_id` (S4 migration).
create or replace function public.set_drive_refresh_token(p_family_id uuid, p_token text, p_passphrase text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.drive_oauth_connections (family_id, refresh_token_enc, connected_at)
  values (p_family_id, extensions.pgp_sym_encrypt(p_token, p_passphrase), now())
  on conflict (family_id) do update
    set refresh_token_enc = excluded.refresh_token_enc,
        updated_at = now();
$$;
revoke all on function public.set_drive_refresh_token(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_drive_refresh_token(uuid, text, text) to service_role;

create or replace function public.get_drive_refresh_token(p_family_id uuid, p_passphrase text)
returns text
language sql
security definer
set search_path = ''
as $$
  select case when refresh_token_enc is null then null
              else extensions.pgp_sym_decrypt(refresh_token_enc, p_passphrase)
         end
    from public.drive_oauth_connections
   where family_id = p_family_id;
$$;
revoke all on function public.get_drive_refresh_token(uuid, text) from public, anon, authenticated;
grant execute on function public.get_drive_refresh_token(uuid, text) to service_role;
