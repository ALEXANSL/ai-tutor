-- BUG-002 (US-1.7 KP-4, KP-10; docs/02 7.6.1): the tutor's grammatical gender
-- before a voice is chosen. Set together with the name: the group (f/m) of a
-- suggested name, or the child's explicit "Вона / Він" choice for an own name.
-- Effective gender = gender of the chosen voice (tutor_voices.gender, S12)
-- when tutor_voice_id is set, otherwise this column. S12 therefore needs no
-- data migration: this column simply stops being consulted once a voice exists.
alter table public.child_profile
  add column tutor_name_gender text not null default 'f'
    check (tutor_name_gender in ('f', 'm'));

comment on column public.child_profile.tutor_name_gender is
  'Grammatical gender implied by the tutor name choice; used only while tutor_voice_id is null (voice gender wins, PM-21).';
