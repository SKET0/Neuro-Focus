-- Neuro-Focus: tighten the live-session workflow.
-- Run after 20261005000000_sessions_attendance.sql. Safe to run more than once.
--
-- 1. Attention history shared with a class is tied to the live session it came from
--    (attention_sessions.class_session_id). A student can only start class-linked history
--    while that class has an open live session they haven't been removed from, so teachers
--    only ever see attention recorded during their own live sessions. History recorded
--    outside a live session stays private to the student (class_id and session both null).
-- 2. Live sessions remember when the teacher's dashboard was last active. A session whose
--    dashboard has been gone for 15 minutes is closed automatically the next time the
--    teacher opens Neuro-Focus, so attendance is finalized even if "End session" was missed.

-- ============================================================
-- 1. Attention history linked to live sessions
-- ============================================================
alter table public.attention_sessions
  add column if not exists class_session_id uuid references public.class_sessions(id) on delete set null;
create index if not exists attention_sessions_class_session_idx on public.attention_sessions(class_session_id);

drop policy if exists "students start their own attention sessions" on public.attention_sessions;
create policy "students start their own attention sessions"
  on public.attention_sessions for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'student')
    and (
      -- Personal history: not shared with anyone.
      (attention_sessions.class_id is null and attention_sessions.class_session_id is null)
      or (
        -- Shared history: only during an open live session of a class the student is in,
        -- and not after the teacher removed them from that session.
        attention_sessions.class_id is not null
        and attention_sessions.class_session_id is not null
        and public.is_class_member(attention_sessions.class_id)
        and exists (
          select 1 from public.class_sessions s
          where s.id = attention_sessions.class_session_id
            and s.class_id = attention_sessions.class_id
            and s.ended_at is null
        )
        and not exists (
          select 1 from public.session_attendance a
          where a.session_id = attention_sessions.class_session_id
            and a.student_id = (select auth.uid())
            and a.removed_at is not null
        )
      )
    )
  );

-- ============================================================
-- 2. Closing sessions whose teacher dashboard went away
-- ============================================================
alter table public.class_sessions add column if not exists last_active_at timestamptz not null default now();

-- The teacher's dashboard calls this every minute while a session is live.
create or replace function public.keep_session_alive(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id uuid;
begin
  select s.class_id into v_class_id from public.class_sessions s where s.id = p_session_id;
  if v_class_id is null or not public.is_class_teacher(v_class_id) then
    raise exception 'Only this class''s teacher can keep its session open.';
  end if;
  update public.class_sessions set last_active_at = now() where id = p_session_id and ended_at is null;
  return found;
end;
$$;

-- Ends this teacher's sessions whose dashboard has been gone for p_minutes. They end at the
-- last moment the dashboard was active; invited students who never joined are marked absent.
create or replace function public.close_stale_sessions(p_minutes integer default 15)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_closed jsonb := '[]'::jsonb;
  v_session public.class_sessions;
begin
  for v_session in
    select s.* from public.class_sessions s
    join public.classes c on c.id = s.class_id
    where c.teacher_id = v_uid
      and s.ended_at is null
      and s.last_active_at < now() - make_interval(mins => greatest(p_minutes, 5))
  loop
    update public.class_sessions set ended_at = greatest(v_session.last_active_at, v_session.started_at) where id = v_session.id;
    update public.session_attendance set status = 'absent' where session_id = v_session.id and status = 'invited';
    v_closed := v_closed || jsonb_build_object('id', v_session.id, 'class_id', v_session.class_id, 'started_at', v_session.started_at, 'ended_at', greatest(v_session.last_active_at, v_session.started_at));
  end loop;
  return v_closed;
end;
$$;

revoke all on function public.keep_session_alive(uuid) from public, anon;
revoke all on function public.close_stale_sessions(integer) from public, anon;
grant execute on function public.keep_session_alive(uuid) to authenticated;
grant execute on function public.close_stale_sessions(integer) to authenticated;
