-- BUG-006 fix: "поточна тема" (US-3.1 KP-1) must be atomic and DB-enforced.
--
-- Before: `setCurrentTopicAction` did three separate, non-transactional
-- PostgREST calls (clear old current -> set new current -> activate
-- subject), and nothing in the schema stopped two topics of the same
-- subject from both being `is_current = true`.
--
-- After: a single `security definer` RPC (`public.set_current_topic`,
-- service_role only) does the clear/set/activate atomically in one
-- transaction, re-validating ownership and the "ready textbook" precondition
-- inside the function (never trusting the caller). A partial unique index
-- backs the invariant at the schema level regardless of which code path
-- writes to `topics`.
--
-- Idempotent: safe to re-run (guards on existing rows/functions/indexes).

-- 1) Bring any existing data in line with the invariant *before* adding the
--    unique index, in case BUG-006 already produced duplicates: for each
--    subject, keep only the most recently updated current topic.
with ranked as (
  select id,
         row_number() over (
           partition by subject_id
           order by updated_at desc, id
         ) as rn
    from public.topics
   where is_current = true
)
update public.topics t
   set is_current = false
  from ranked
 where t.id = ranked.id
   and ranked.rn > 1;

-- 2) Schema-level safety net: at most one current topic per subject, no
--    matter how many code paths (future RPCs, manual SQL, scripts) write to
--    `topics`.
create unique index if not exists topics_one_current_per_subject_idx
  on public.topics (subject_id)
  where is_current;

-- 3) Atomic RPC: clear -> set -> activate in a single transaction, with the
--    same server-side guards `setCurrentTopicAction` used to run as
--    separate, racy queries (subject/topic ownership, ready+enabled
--    textbook present). Raises a distinct errcode per precondition so the
--    server action can map it back to the right user-facing message.
create or replace function public.set_current_topic(p_family_id uuid, p_subject_id uuid, p_topic_id uuid)
returns table (out_subject_id uuid, out_topic_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject_id    uuid;
  v_topic_subject uuid;
  v_ready_count   integer;
begin
  select s.id into v_subject_id
    from public.subjects s
   where s.id = p_subject_id
     and s.owner_family_id = p_family_id
     and s.is_stub = false;
  if v_subject_id is null then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;

  select t.subject_id into v_topic_subject
    from public.topics t
   where t.id = p_topic_id
     and t.owner_family_id = p_family_id;
  if v_topic_subject is null or v_topic_subject <> p_subject_id then
    raise exception using errcode = 'P0003', message = 'topic_not_found';
  end if;

  select count(*) into v_ready_count
    from public.materials m
   where m.subject_id = p_subject_id
     and m.owner_family_id = p_family_id
     and m.kind = 'textbook'
     and m.status = 'ready'
     and m.use_in_lessons = true;
  if v_ready_count = 0 then
    raise exception using errcode = 'P0004', message = 'no_textbook';
  end if;

  update public.topics
     set is_current = false
   where subject_id = p_subject_id
     and owner_family_id = p_family_id
     and is_current = true
     and id <> p_topic_id;

  update public.topics
     set is_current = true
   where id = p_topic_id
     and owner_family_id = p_family_id;

  update public.subjects
     set active = true
   where id = p_subject_id
     and owner_family_id = p_family_id;

  return query select p_subject_id, p_topic_id;
end;
$$;

revoke all on function public.set_current_topic(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_current_topic(uuid, uuid, uuid) to service_role;
