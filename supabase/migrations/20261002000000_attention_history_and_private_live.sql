-- Neuro-Focus Phase 2: saved attention history + private live class channels.
-- Safe to run more than once in the Supabase SQL Editor.

-- ============================================================
-- 1. Attention history (ERD: Session -> Attention Score)
-- ============================================================

-- One row per attention-tracking session. The student's browser keeps the summary
-- columns up to date while tracking, so a closed tab still leaves a useful record.
create table if not exists public.attention_sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  tracked_seconds integer not null default 0 check (tracked_seconds between 0 and 86400),
  average_score smallint check (average_score between 0 and 100),
  focus_percent smallint check (focus_percent between 0 and 100),
  lapses integer not null default 0 check (lapses between 0 and 100000),
  best_streak_seconds integer not null default 0 check (best_streak_seconds between 0 and 86400)
);

-- One row per 5 seconds of tracking: the average attention score and dominant state.
-- Only numbers computed on the student's device are stored, never video or images.
create table if not exists public.attention_samples (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.attention_sessions(id) on delete cascade,
  student_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  recorded_at timestamptz not null default now(),
  score smallint not null check (score between 0 and 100),
  state text not null check (state in ('Focused', 'Distracted', 'Away'))
);

create index if not exists attention_sessions_student_idx on public.attention_sessions(student_id, started_at desc);
create index if not exists attention_sessions_class_idx on public.attention_sessions(class_id, started_at desc);
create index if not exists attention_samples_class_idx on public.attention_samples(class_id, recorded_at desc);
create index if not exists attention_samples_session_idx on public.attention_samples(session_id, recorded_at);

alter table public.attention_sessions enable row level security;
alter table public.attention_samples enable row level security;

-- Students see their own history; teachers see history for their own classes.
drop policy if exists "attention sessions readable by owner and class teacher" on public.attention_sessions;
create policy "attention sessions readable by owner and class teacher"
  on public.attention_sessions for select to authenticated
  using (student_id = (select auth.uid()) or (class_id is not null and public.is_class_teacher(class_id)));

drop policy if exists "students start their own attention sessions" on public.attention_sessions;
create policy "students start their own attention sessions"
  on public.attention_sessions for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'student')
    and (class_id is null or public.is_class_member(class_id))
  );

drop policy if exists "students update their own attention sessions" on public.attention_sessions;
create policy "students update their own attention sessions"
  on public.attention_sessions for update to authenticated
  using (student_id = (select auth.uid()))
  with check (student_id = (select auth.uid()));

drop policy if exists "attention samples readable by owner and class teacher" on public.attention_samples;
create policy "attention samples readable by owner and class teacher"
  on public.attention_samples for select to authenticated
  using (student_id = (select auth.uid()) or (class_id is not null and public.is_class_teacher(class_id)));

drop policy if exists "students record samples in their own sessions" on public.attention_samples;
create policy "students record samples in their own sessions"
  on public.attention_samples for insert to authenticated
  with check (
    attention_samples.student_id = (select auth.uid())
    and exists (
      select 1 from public.attention_sessions s
      where s.id = attention_samples.session_id
        and s.student_id = (select auth.uid())
        and s.class_id is not distinct from attention_samples.class_id
    )
  );

-- Only the columns the app needs; summary columns are the only ones students can change.
revoke all on public.attention_sessions from anon, authenticated;
revoke all on public.attention_samples from anon, authenticated;
grant select, insert on public.attention_sessions to authenticated;
grant update (last_seen_at, ended_at, tracked_seconds, average_score, focus_percent, lapses, best_streak_seconds)
  on public.attention_sessions to authenticated;
grant select, insert on public.attention_samples to authenticated;

-- ============================================================
-- 2. Private live class channels (Supabase Realtime Authorization)
-- ============================================================
-- Channel topic: neurofocus-class-<class id>
--   Presence (who is online): readable by the class teacher and its students.
--   Broadcast (live attention scores): only the class teacher can receive;
--   only students of the class can send. Classmates never receive each other's scores.

create or replace function public.class_id_from_realtime_topic(topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when topic ~* '^neurofocus-class-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then substring(topic from 18)::uuid
  end;
$$;

revoke all on function public.class_id_from_realtime_topic(text) from public, anon;
grant execute on function public.class_id_from_realtime_topic(text) to authenticated;

drop policy if exists "neurofocus class channels: receive" on realtime.messages;
create policy "neurofocus class channels: receive"
  on realtime.messages for select to authenticated
  using (
    (
      realtime.messages.extension = 'presence'
      and (
        public.is_class_teacher(public.class_id_from_realtime_topic((select realtime.topic())))
        or public.is_class_member(public.class_id_from_realtime_topic((select realtime.topic())))
      )
    )
    or (
      realtime.messages.extension = 'broadcast'
      and public.is_class_teacher(public.class_id_from_realtime_topic((select realtime.topic())))
    )
  );

drop policy if exists "neurofocus class channels: send" on realtime.messages;
create policy "neurofocus class channels: send"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('presence', 'broadcast')
    and public.is_class_member(public.class_id_from_realtime_topic((select realtime.topic())))
  );
