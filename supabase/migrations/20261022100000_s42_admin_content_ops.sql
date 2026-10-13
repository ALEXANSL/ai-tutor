-- =============================================================================
-- S42 (E-29, US-29.1/29.2/29.3, D-125): admin content operations without
-- SQL — removes the repeated manual Supabase SQL Editor steps documented in
-- docs/STATUS.md (2026-10-02…2026-10-08): clearing a subject's old content
-- before a re-import, linking `textbook_material_id` by hand, and
-- disabling/deleting a single stray lesson/topic.
--
-- Same two-layer "parent only" gate as every other admin RPC in this
-- project (`set_current_topic`, the S31 subject/course RPCs): the server
-- action calls `requireParentAccess()` first, then the RPC itself is
-- SECURITY DEFINER, revoked from everyone but `service_role`, and
-- independently re-checks `owner_family_id = p_family_id` for anything the
-- caller passed in.
--
-- ВП-76 (ЗАКРИТО 2026-10-13): "архівувати, не видаляти" — US-29.1's cleanup
-- NEVER deletes a row. It only flips `status` to 'archived', the same
-- principle already used for `academic_years`/`library_items`-style status
-- columns elsewhere in this schema. Nothing a child has already done
-- (step_attempts, course_v2_question_attempts, chat history) is touched —
-- those rows reference topic_id/question_id, never a lesson's `status`, so
-- archiving a lesson cannot lose them.
--
-- Safe to re-run in the Supabase SQL Editor (IF NOT EXISTS / OR REPLACE /
-- guarded ALTER everywhere).
-- =============================================================================

-- 1) topics.status — mirrors the lesson tables' own status column, so a
--    subject-wide cleanup can mark "this topic's old content is gone" even
--    for a topic that pre-dates S33/S34/S35/S36 (an orphaned old-pipeline
--    topic with no lesson row at all in any of the four systems — exactly
--    the case `cleanup-old-topics.sql` was hand-written for on 2026-10-02).
alter table public.topics
  add column if not exists status text not null default 'active' check (status in ('active', 'archived'));
create index if not exists topics_status_idx on public.topics (subject_id, status);

-- 2) Widen the four parallel lesson-import systems' status check to add
--    'disabled' (US-29.3 КП-1, a reversible single-lesson/topic toggle —
--    the child never sees it, the parent can turn it back on) and
--    'archived' (US-29.1, subject-wide "old content" cleanup, not meant to
--    be toggled back through the ordinary per-lesson switch). Both already
--    sit outside `status = 'active'`, so the existing child RLS policies
--    (`*_select_child`, `status = 'active'`) and `getSubjectDetail`'s own
--    `.eq("status", "active")` lookups hide both the same way, with no
--    code change needed there.
alter table public.literature_lessons drop constraint if exists literature_lessons_status_check;
alter table public.literature_lessons add constraint literature_lessons_status_check
  check (status in ('active', 'needs_review', 'disabled', 'archived'));

alter table public.course_lessons drop constraint if exists course_lessons_status_check;
alter table public.course_lessons add constraint course_lessons_status_check
  check (status in ('active', 'needs_review', 'disabled', 'archived'));

alter table public.course_v2_lessons drop constraint if exists course_v2_lessons_status_check;
alter table public.course_v2_lessons add constraint course_v2_lessons_status_check
  check (status in ('active', 'needs_review', 'disabled', 'archived'));

alter table public.literature_v2_lessons drop constraint if exists literature_v2_lessons_status_check;
alter table public.literature_v2_lessons add constraint literature_v2_lessons_status_check
  check (status in ('active', 'needs_review', 'disabled', 'archived'));

-- =============================================================================
-- 3) SECURITY DEFINER RPCs.
-- =============================================================================

-- admin_archive_subject_content (US-29.1 КП-4): archives every not-yet-
-- archived lesson row of the subject across all four systems, plus every
-- not-yet-archived topic of the subject (including old-pipeline topics with
-- no lesson row at all) — one atomic statement per table, all inside the
-- function's own implicit transaction. Returns how many lesson rows and
-- topic rows were just archived, for the parent-facing confirmation toast.
create or replace function public.admin_archive_subject_content(p_family_id uuid, p_subject_id uuid)
returns table (out_lessons_archived integer, out_topics_archived integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_lessons_archived integer := 0;
  v_topics_archived  integer := 0;
  v_n                integer;
begin
  if not exists (select 1 from public.subjects where id = p_subject_id and owner_family_id = p_family_id) then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;

  update public.literature_lessons set status = 'archived'
   where subject_id = p_subject_id and owner_family_id = p_family_id and status <> 'archived';
  get diagnostics v_n = row_count; v_lessons_archived := v_lessons_archived + v_n;

  update public.course_lessons set status = 'archived'
   where subject_id = p_subject_id and owner_family_id = p_family_id and status <> 'archived';
  get diagnostics v_n = row_count; v_lessons_archived := v_lessons_archived + v_n;

  update public.course_v2_lessons set status = 'archived'
   where subject_id = p_subject_id and owner_family_id = p_family_id and status <> 'archived';
  get diagnostics v_n = row_count; v_lessons_archived := v_lessons_archived + v_n;

  update public.literature_v2_lessons set status = 'archived'
   where subject_id = p_subject_id and owner_family_id = p_family_id and status <> 'archived';
  get diagnostics v_n = row_count; v_lessons_archived := v_lessons_archived + v_n;

  update public.topics set status = 'archived', is_current = false
   where subject_id = p_subject_id and owner_family_id = p_family_id and status <> 'archived';
  get diagnostics v_topics_archived = row_count;

  return query select v_lessons_archived, v_topics_archived;
end; $$;
revoke all on function public.admin_archive_subject_content(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_archive_subject_content(uuid, uuid) to service_role;

-- admin_set_lesson_status (US-29.3 КП-1): the single-lesson on/off switch.
-- `p_system` picks which of the four parallel tables the id belongs to —
-- the client already knows this (it is the table the row came from), so
-- this is not client-guessable/ambiguous. Only 'active'/'disabled' are
-- accepted here (never 'archived'/'needs_review' — those are not this
-- action's job).
create or replace function public.admin_set_lesson_status(p_family_id uuid, p_system text, p_lesson_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('active', 'disabled') then
    raise exception using errcode = 'P0014', message = 'invalid_status';
  end if;

  if p_system = 'literature' then
    update public.literature_lessons set status = p_status where id = p_lesson_id and owner_family_id = p_family_id;
  elsif p_system = 'course' then
    update public.course_lessons set status = p_status where id = p_lesson_id and owner_family_id = p_family_id;
  elsif p_system = 'course_v2' then
    update public.course_v2_lessons set status = p_status where id = p_lesson_id and owner_family_id = p_family_id;
  elsif p_system = 'literature_v2' then
    update public.literature_v2_lessons set status = p_status where id = p_lesson_id and owner_family_id = p_family_id;
  else
    raise exception using errcode = 'P0015', message = 'invalid_system';
  end if;

  if not found then
    raise exception using errcode = 'P0003', message = 'lesson_not_found';
  end if;
end; $$;
revoke all on function public.admin_set_lesson_status(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_lesson_status(uuid, text, uuid, text) to service_role;

-- admin_delete_lesson (US-29.3 КП-2): permanent delete, allowed ONLY when
-- deleting it cannot lose any recorded child progress. Of the four systems,
-- only `course_v2` has a real attempt-tracking table today
-- (`course_v2_question_attempts`, FK `on delete cascade` from its
-- question's lesson) — the other three have no attempt/progress table at
-- all yet, so there is nothing for a delete to lose there. This mirrors the
-- same "delete only when truly empty" rule E-22 already applies to a whole
-- subject (US-22.1 КП-4).
create or replace function public.admin_delete_lesson(p_family_id uuid, p_system text, p_lesson_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_has_progress boolean;
begin
  if p_system = 'literature' then
    if not exists (select 1 from public.literature_lessons where id = p_lesson_id and owner_family_id = p_family_id) then
      raise exception using errcode = 'P0003', message = 'lesson_not_found';
    end if;
    delete from public.literature_lessons where id = p_lesson_id and owner_family_id = p_family_id;
  elsif p_system = 'course' then
    if not exists (select 1 from public.course_lessons where id = p_lesson_id and owner_family_id = p_family_id) then
      raise exception using errcode = 'P0003', message = 'lesson_not_found';
    end if;
    delete from public.course_lessons where id = p_lesson_id and owner_family_id = p_family_id;
  elsif p_system = 'course_v2' then
    if not exists (select 1 from public.course_v2_lessons where id = p_lesson_id and owner_family_id = p_family_id) then
      raise exception using errcode = 'P0003', message = 'lesson_not_found';
    end if;
    select exists (
      select 1
        from public.course_v2_question_attempts a
        join public.course_v2_questions q on q.id = a.question_id
       where q.lesson_id = p_lesson_id
    ) into v_has_progress;
    if v_has_progress then
      raise exception using errcode = 'P0016', message = 'has_progress';
    end if;
    delete from public.course_v2_lessons where id = p_lesson_id and owner_family_id = p_family_id;
  elsif p_system = 'literature_v2' then
    if not exists (select 1 from public.literature_v2_lessons where id = p_lesson_id and owner_family_id = p_family_id) then
      raise exception using errcode = 'P0003', message = 'lesson_not_found';
    end if;
    delete from public.literature_v2_lessons where id = p_lesson_id and owner_family_id = p_family_id;
  else
    raise exception using errcode = 'P0015', message = 'invalid_system';
  end if;
end; $$;
revoke all on function public.admin_delete_lesson(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_lesson(uuid, text, uuid) to service_role;

-- admin_set_package_textbook (US-29.2 КП-1/КП-2): the form replacement for
-- the hand-run `UPDATE ... SET textbook_material_id = '<uuid>'` the
-- developer had to run for S35/S36 (`20261019100000_s35_textbook_page_link.sql`,
-- `20261021100000_s36c_literature_v2_textbook_link.sql`). `p_material_id`
-- may be null to clear the link. Applies to the WHOLE package at once
-- (КП-2 — every lesson of the package shares one `textbook_material_id`
-- column on the package row, so "apply to all lessons" is automatic, not a
-- loop).
create or replace function public.admin_set_package_textbook(p_family_id uuid, p_kind text, p_package_id uuid, p_material_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_material_id is not null and not exists (
    select 1 from public.materials where id = p_material_id and owner_family_id = p_family_id and format = 'pdf'
  ) then
    raise exception using errcode = 'P0017', message = 'material_not_found';
  end if;

  if p_kind = 'course_v2' then
    update public.course_v2_packages set textbook_material_id = p_material_id
     where id = p_package_id and owner_family_id = p_family_id;
  elsif p_kind = 'literature_v2' then
    update public.literature_v2_packages set textbook_material_id = p_material_id
     where id = p_package_id and owner_family_id = p_family_id;
  else
    raise exception using errcode = 'P0015', message = 'invalid_system';
  end if;

  if not found then
    raise exception using errcode = 'P0002', message = 'subject_not_found';
  end if;
end; $$;
revoke all on function public.admin_set_package_textbook(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_package_textbook(uuid, text, uuid, uuid) to service_role;
