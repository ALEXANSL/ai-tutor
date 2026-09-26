-- BUG-023: "manual_exit" (BUG-020, "Вийти з уроку" button) was added to the
-- TypeScript PauseReason union but never added to the DB check constraint,
-- so pauseLessonAction(sessionId, "manual_exit") fails in production.
alter table public.lesson_sessions drop constraint if exists lesson_sessions_pause_reason_check;

alter table public.lesson_sessions
  add constraint lesson_sessions_pause_reason_check
  check (pause_reason in ('manual_alert', 'air_alert', 'idle', 'network', 'budget_hard', 'parent_mode', 'break', 'manual_exit'));
