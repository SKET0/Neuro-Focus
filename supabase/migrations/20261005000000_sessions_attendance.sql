-- Neuro-Focus: saved live sessions, automatic invites, removing a student from a session,
-- and attendance. Run after 20261003000000_class_management.sql. Safe to run more than once.
--
-- * Every student on a class's master list (class_members) is invited automatically when the
--   teacher starts a live session. Students who join the class during a session are invited too.
-- * A teacher can remove a student from a live session (and let them back in). The student
--   stays on the master list; only class removal takes them off it.
-- * Attendance is marked automatically: present when a student joins the session, late after
--   the class's late threshold, absent when the session ends without them. Teachers can change
--   any mark (present, late, absent, excused). Each record keeps the student's name, so it
--   survives the student later leaving the class.

-- ============================================================
-- 1. Tables
-- ============================================================

-- Minutes after the start when joining counts as late.
alter table public.classes add column if not exists late_after_minutes smallint not null default 10
  check (late_after_minutes between 0 and 240);
grant update (name, joining_open, late_after_minutes) on public.classes to authenticated;

create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  late_after_minutes smallint not null default 10
);
create index if not exists class_sessions_class_idx on public.class_sessions(class_id, started_at desc);
-- At most one open session per class.
create unique index if not exists class_sessions_one_open_idx on public.class_sessions(class_id) where ended_at is null;

create table if not exists public.session_attendance (
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  student_name text not null default 'Student',
  status text not null default 'invited' check (status in ('invited', 'present', 'late', 'absent', 'excused')),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  last_seen_at timestamptz,
  attended_seconds integer not null default 0 check (attended_seconds between 0 and 86400),
  removed_at timestamptz,          -- set while the teacher has removed the student from this session
  marked_by_teacher boolean not null default false,
  primary key (session_id, student_id)
);
create index if not exists session_attendance_class_idx on public.session_attendance(class_id, student_id);
create index if not exists session_attendance_student_idx on public.session_attendance(student_id);

alter table public.class_sessions enable row level security;
alter table public.session_attendance enable row level security;

-- Teachers see their classes' sessions; students see sessions of classes they're in.
drop policy if exists "class sessions visible to teacher and members" on public.class_sessions;
create policy "class sessions visible to teacher and members"
  on public.class_sessions for select to authenticated
  using (public.is_class_teacher(class_id) or public.is_class_member(class_id));

-- Teachers can delete a session record (and its attendance) made by mistake.
drop policy if exists "teachers delete their class sessions" on public.class_sessions;
create policy "teachers delete their class sessions"
  on public.class_sessions for delete to authenticated
  using (public.is_class_teacher(class_id));

-- Teachers see attendance for their classes; students see only their own.
drop policy if exists "attendance visible to teacher and the student" on public.session_attendance;
create policy "attendance visible to teacher and the student"
  on public.session_attendance for select to authenticated
  using (student_id = (select auth.uid()) or public.is_class_teacher(class_id));

-- Everything else goes through the functions below.
revoke all on public.class_sessions, public.session_attendance from anon, authenticated;
grant select, delete on public.class_sessions to authenticated;
grant select on public.session_attendance to authenticated;

-- ============================================================
-- 2. Functions
-- ============================================================

-- Invites every master-list student who doesn't have an attendance row yet.
create or replace function public.invite_class_members(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.class_sessions;
  v_count integer;
begin
  select s.* into v_session from public.class_sessions s where s.id = p_session_id;
  if not found or not public.is_class_teacher(v_session.class_id) then
    raise exception 'Only this class''s teacher can invite students.';
  end if;
  if v_session.ended_at is not null then return 0; end if;
  insert into public.session_attendance (session_id, class_id, student_id, student_name)
  select v_session.id, v_session.class_id, m.student_id, coalesce(p.display_name, 'Student')
  from public.class_members m
  join public.profiles p on p.id = m.student_id
  where m.class_id = v_session.class_id
  on conflict (session_id, student_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Ends a session: anyone invited who never joined is marked absent.
create or replace function public.end_class_session(p_session_id uuid)
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
    raise exception 'Only this class''s teacher can end its session.';
  end if;
  update public.class_sessions set ended_at = now() where id = p_session_id and ended_at is null;
  update public.session_attendance set status = 'absent'
  where session_id = p_session_id and status = 'invited';
  return true;
end;
$$;

-- Starts a live session and invites the whole master list. The teacher's other open sessions
-- (any class) are ended first, since a teacher runs one live session at a time.
create or replace function public.start_class_session(p_class_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_session public.class_sessions;
  v_open uuid;
  v_invited integer;
begin
  if not public.is_class_teacher(p_class_id) then
    raise exception 'Only this class''s teacher can start a live session.';
  end if;
  for v_open in
    select s.id from public.class_sessions s
    join public.classes c on c.id = s.class_id
    where s.ended_at is null and c.teacher_id = v_uid
  loop
    perform public.end_class_session(v_open);
  end loop;

  insert into public.class_sessions (class_id, teacher_id, late_after_minutes)
  select c.id, v_uid, c.late_after_minutes from public.classes c where c.id = p_class_id
  returning * into v_session;
  v_invited := public.invite_class_members(v_session.id);
  return jsonb_build_object('id', v_session.id, 'class_id', v_session.class_id, 'started_at', v_session.started_at, 'invited', v_invited);
end;
$$;

-- Students call this when they join a live session and then every 30 seconds while in it.
-- It marks them present (or late) and adds up the time they were there.
create or replace function public.check_in_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_session public.class_sessions;
  v_row public.session_attendance;
  v_gap numeric;
begin
  select s.* into v_session from public.class_sessions s where s.id = p_session_id;
  if not found or not public.is_class_member(v_session.class_id) then
    raise exception 'That live session isn''t available to your account.';
  end if;
  if v_session.ended_at is not null then
    return jsonb_build_object('status', 'ended', 'removed', false);
  end if;

  -- Students who joined the class after the session started are invited now.
  insert into public.session_attendance (session_id, class_id, student_id, student_name)
  select v_session.id, v_session.class_id, v_uid, coalesce(p.display_name, 'Student')
  from public.profiles p where p.id = v_uid
  on conflict (session_id, student_id) do nothing;

  select a.* into v_row from public.session_attendance a where a.session_id = p_session_id and a.student_id = v_uid for update;
  if v_row.removed_at is not null then
    return jsonb_build_object('status', v_row.status, 'removed', true);
  end if;

  v_gap := extract(epoch from (now() - v_row.last_seen_at));
  update public.session_attendance a set
    joined_at = coalesce(a.joined_at, now()),
    last_seen_at = now(),
    attended_seconds = least(86400, a.attended_seconds + case when v_gap is not null and v_gap <= 75 then round(v_gap)::integer else 0 end),
    status = case
      when a.marked_by_teacher or a.status not in ('invited', 'absent') then a.status
      when now() > v_session.started_at + make_interval(mins => v_session.late_after_minutes) then 'late'
      else 'present'
    end
  where a.session_id = p_session_id and a.student_id = v_uid
  returning * into v_row;
  return jsonb_build_object('status', v_row.status, 'removed', false);
end;
$$;

-- Teacher removes a student from a live session (p_remove = true) or lets them back in.
create or replace function public.set_session_removed(p_session_id uuid, p_student_id uuid, p_remove boolean)
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
    raise exception 'Only this class''s teacher can change who is in the session.';
  end if;
  insert into public.session_attendance (session_id, class_id, student_id, student_name)
  select p_session_id, v_class_id, p.id, coalesce(p.display_name, 'Student')
  from public.profiles p
  where p.id = p_student_id
    and exists (select 1 from public.class_members m where m.class_id = v_class_id and m.student_id = p_student_id)
  on conflict (session_id, student_id) do nothing;
  update public.session_attendance
  set removed_at = case when p_remove then now() else null end
  where session_id = p_session_id and student_id = p_student_id;
  return found;
end;
$$;

-- Teacher changes an attendance mark.
create or replace function public.set_attendance(p_session_id uuid, p_student_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_class_id uuid;
begin
  if p_status not in ('present', 'late', 'absent', 'excused') then
    raise exception 'Attendance can be present, late, absent or excused.';
  end if;
  select s.class_id into v_class_id from public.class_sessions s where s.id = p_session_id;
  if v_class_id is null or not public.is_class_teacher(v_class_id) then
    raise exception 'Only this class''s teacher can change attendance.';
  end if;
  update public.session_attendance
  set status = p_status, marked_by_teacher = true
  where session_id = p_session_id and student_id = p_student_id;
  return found;
end;
$$;

revoke all on function public.invite_class_members(uuid) from public, anon;
revoke all on function public.end_class_session(uuid) from public, anon;
revoke all on function public.start_class_session(uuid) from public, anon;
revoke all on function public.check_in_session(uuid) from public, anon;
revoke all on function public.set_session_removed(uuid, uuid, boolean) from public, anon;
revoke all on function public.set_attendance(uuid, uuid, text) from public, anon;
grant execute on function public.invite_class_members(uuid) to authenticated;
grant execute on function public.end_class_session(uuid) to authenticated;
grant execute on function public.start_class_session(uuid) to authenticated;
grant execute on function public.check_in_session(uuid) to authenticated;
grant execute on function public.set_session_removed(uuid, uuid, boolean) to authenticated;
grant execute on function public.set_attendance(uuid, uuid, text) to authenticated;
