-- S46: friend threads, child-view clearing, and bounded voice leases. Safe to re-run.
begin;
alter table public.chats add column if not exists title text not null default 'Нова розмова';
alter table public.chats add column if not exists updated_at timestamptz not null default now();
alter table public.chats add column if not exists cleared_at timestamptz;
alter table public.chats add column if not exists archived_at timestamptz;
alter table public.chats add column if not exists revision integer not null default 0;
create index if not exists chats_friend_recent_idx on public.chats(child_profile_id, updated_at desc) where kind='friend' and archived_at is null;

create or replace function public.append_friend_message(p_family_id uuid, p_child_id uuid, p_chat_id uuid, p_revision integer, p_author text, p_content text, p_voice boolean default false)
returns table(id uuid, created_at timestamptz) language plpgsql security definer set search_path='' as $$
declare c public.chats;
begin
 select * into c from public.chats where chats.id=p_chat_id and family_id=p_family_id and child_profile_id=p_child_id and kind='friend' and archived_at is null for update;
 if not found or p_revision is null or c.revision<>p_revision then raise exception 'chat_changed'; end if;
 if p_author is null or p_author not in ('child','ai') or p_content is null or length(btrim(p_content)) not between 1 and 2000 then raise exception 'invalid_message'; end if;
 update public.chats set updated_at=clock_timestamp(), title=case when title='Нова розмова' and p_author='child' then left(p_content,60) else title end where chats.id=p_chat_id;
 return query insert into public.messages(family_id,chat_id,author,type,content,created_at)
 values(p_family_id,p_chat_id,p_author,case when p_voice then 'voice_transcript' else 'text' end,p_content,clock_timestamp())
 returning messages.id,messages.created_at;
end $$;
revoke all on function public.append_friend_message(uuid,uuid,uuid,integer,text,text,boolean) from public,anon,authenticated;
grant execute on function public.append_friend_message(uuid,uuid,uuid,integer,text,text,boolean) to service_role;

-- Clearing affects only the child view/context; the parent retains the transcript.
-- Row lock + revision prevents overlapping tabs or a late generation resurrecting history.
create or replace function public.edit_friend_chat(p_family_id uuid,p_child_id uuid,p_chat_id uuid,p_revision integer,p_action text,p_title text default null)
returns public.chats language plpgsql security definer set search_path='' as $$
declare c public.chats;
begin
 select * into c from public.chats where id=p_chat_id and family_id=p_family_id and child_profile_id=p_child_id and kind='friend' and archived_at is null for update;
 if not found or p_revision is null or c.revision<>p_revision then raise exception 'chat_changed'; end if;
 if p_action='clear' then
  update public.chats set cleared_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 where id=p_chat_id returning * into c;
 elsif p_action='archive' then
  update public.chats set archived_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 where id=p_chat_id returning * into c;
 elsif p_action='rename' then
  if p_title is null or length(btrim(p_title)) not between 1 and 60 then raise exception 'invalid_title'; end if;
  update public.chats set title=btrim(p_title),updated_at=clock_timestamp() where id=p_chat_id returning * into c;
 else raise exception 'invalid_action';
 end if;
 return c;
end $$;
revoke all on function public.edit_friend_chat(uuid,uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.edit_friend_chat(uuid,uuid,uuid,integer,text,text) to service_role;

create table if not exists public.voice_sessions (
 id uuid primary key default gen_random_uuid(),
 family_id uuid not null references public.families(id) on delete cascade,
 child_profile_id uuid not null references public.child_profile(id) on delete cascade,
 target jsonb not null,
 started_at timestamptz not null default now(),
 expires_at timestamptz not null,
 ended_at timestamptz,
 busy_until timestamptz
);
create index if not exists voice_sessions_child_idx on public.voice_sessions(child_profile_id,started_at);
alter table public.voice_sessions enable row level security;
revoke all on public.voice_sessions from anon,authenticated;
grant all on public.voice_sessions to service_role;

-- One session per child; quota and renewal use server time and a per-child lock.
create or replace function public.manage_voice_session(p_family_id uuid,p_child_id uuid,p_target jsonb default null,p_id uuid default null,p_stop boolean default false)
returns public.voice_sessions language plpgsql security definer set search_path='' as $$
declare v public.voice_sessions; t timestamptz:=clock_timestamp(); used numeric; remaining numeric; day_start timestamptz; deadline timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_child_id::text,46));
 t:=clock_timestamp();
 if not exists(select 1 from public.child_profile where id=p_child_id and family_id=p_family_id) then raise exception 'not_found'; end if;
 day_start:=date_trunc('day',t at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv';
 if p_id is not null then
  select * into v from public.voice_sessions where id=p_id and family_id=p_family_id and child_profile_id=p_child_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_stop then
   update public.voice_sessions set ended_at=coalesce(ended_at,least(t,expires_at)) where id=p_id returning * into v;
   return v;
  end if;
  if v.ended_at is not null or v.expires_at<=t or (v.target->>'kind'='friend' and v.started_at<day_start) then raise exception 'voice_expired'; end if;
 else
  if not coalesce(p_target->>'kind' in ('friend','lesson','course'),false) or p_stop then raise exception 'invalid_target'; end if;
  update public.voice_sessions set ended_at=least(t,expires_at) where child_profile_id=p_child_id and ended_at is null;
  insert into public.voice_sessions(family_id,child_profile_id,target,started_at,expires_at) values(p_family_id,p_child_id,p_target,t,t) returning * into v;
 end if;
 deadline:=t+interval '60 seconds';
 if v.target->>'kind'='friend' then
  select coalesce(sum(extract(epoch from greatest(least(coalesce(ended_at,t),expires_at)-greatest(started_at,day_start),interval '0'))),0) into used
   from public.voice_sessions where child_profile_id=p_child_id and family_id=p_family_id and target->>'kind'='friend' and started_at>=day_start;
  remaining:=600-used;
  if remaining<=0 then raise exception 'voice_limit'; end if;
  deadline:=least(deadline,t+remaining*interval '1 second',(date_trunc('day',t at time zone 'Europe/Kyiv')+interval '1 day') at time zone 'Europe/Kyiv');
 end if;
 update public.voice_sessions set expires_at=deadline where id=v.id returning * into v;
 return v;
end $$;
revoke all on function public.manage_voice_session(uuid,uuid,jsonb,uuid,boolean) from public,anon,authenticated;
grant execute on function public.manage_voice_session(uuid,uuid,jsonb,uuid,boolean) to service_role;

create or replace function public.claim_voice_turn(p_family_id uuid,p_child_id uuid,p_id uuid)
returns public.voice_sessions language plpgsql security definer set search_path='' as $$
declare v public.voice_sessions;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_child_id::text,46));
 update public.voice_sessions set busy_until=clock_timestamp()+interval '90 seconds'
 where id=p_id and family_id=p_family_id and child_profile_id=p_child_id and ended_at is null and expires_at>clock_timestamp() and (busy_until is null or busy_until<clock_timestamp()) returning * into v;
 if not found then raise exception 'voice_expired_or_busy'; end if;
 return v;
end $$;
revoke all on function public.claim_voice_turn(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_voice_turn(uuid,uuid,uuid) to service_role;

insert into public.model_prices(provider,model,input_usd_per_mtok,output_usd_per_mtok,notes)
values('openai','whisper-1',100,0,'$0.006/min; input_tokens records rounded audio seconds, $100 per million seconds.') on conflict(provider,model) do nothing;
-- Independent trigger adds voice routes without replacing existing role-seeding triggers.
create or replace function app_private.seed_s46_voice_routes(p_family uuid) returns void language sql security definer set search_path='' as $$
 insert into public.model_routes(family_id,role,primary_provider,primary_model,params) values
 (p_family,'voice_transcription','openai','whisper-1','{"timeout_ms":30000,"budget_policy":"defer"}'),
 (p_family,'voice_reply','openai','gpt-4o-mini-tts','{"timeout_ms":30000,"budget_policy":"defer"}') on conflict(family_id,role) do nothing;
$$;
revoke all on function app_private.seed_s46_voice_routes(uuid) from public;
create or replace function app_private.seed_voice_for_new_family() returns trigger language plpgsql security definer set search_path='' as $$
begin perform app_private.seed_s46_voice_routes(new.id); return new; end $$;
drop trigger if exists family_voice_routes on public.families;
create trigger family_voice_routes after insert on public.families for each row execute function app_private.seed_voice_for_new_family();
select app_private.seed_s46_voice_routes(id) from public.families;
commit;
