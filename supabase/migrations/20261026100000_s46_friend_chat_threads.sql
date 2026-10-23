-- S46 (US-8.5 follow-up, Алекс 2026-10-23): "ШІ-друг" becomes multiple named
-- chats per child instead of one continuous chat — "окремі іменовані чати".
-- "Delete" is a child-facing hide only (Алекс: "прибрати з очей дитини, але
-- зберегти для батьківського перегляду") — US-8.5 КП-3 requires the parent
-- to see everything verbatim, so no row is ever deleted; `/parent/conversations`
-- already selects every `chats` row with no filter, so it keeps seeing a
-- hidden chat unchanged (no RLS change needed — selects are unaffected,
-- writes already go through the service-role client only, per the existing
-- `revoke insert, update, delete ... from authenticated` on this table).
alter table public.chats
  add column if not exists title text,
  add column if not exists hidden_from_child_at timestamptz;
